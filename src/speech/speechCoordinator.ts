// 协调单个 Turn 的文本清理、切句、顺序合成、事件发射和音频归档。
import type { TextToSpeech, TtsAudioFormat, TtsVoice } from '@ema-agent/tts';
import { createUsageRecord, reportUsage } from '@ema-agent/usage';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';

import type { AudioArchive, FinalizedAudio, SegmentWriter } from './audioArchive.js';
import { audioChunkEvent, makeSentenceId } from './eventProjection.js';
import type { SpeechEvent } from './events.js';
import { SentenceSplitter } from './sentenceSplitter.js';
import { filterSentenceForTts, TextFilterStream } from './textFilter.js';

const DEFAULT_MAX_BYTES_PER_SENTENCE = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_TURN = 64 * 1024 * 1024;
const DEFAULT_SENTENCE_TIMEOUT_MS = 120_000;

export interface SpeechCoordinatorArgs {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerConfigId: string;
  readonly model: string;
  readonly voice: TtsVoice;
  readonly textToSpeech: TextToSpeech;
  readonly emit: (event: SpeechEvent) => void;
  readonly archive?: AudioArchive;
  readonly format?: TtsAudioFormat;
  readonly signal?: AbortSignal;
  readonly usageRecorder?: UsageRecorder;
  readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
  readonly sentenceTimeoutMs?: number;
  readonly maxBytesPerSentence?: number;
  readonly maxBytesPerTurn?: number;
}

type SpeechCoordinatorState =
  | 'accepting'
  | 'finishing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'failed';

export class SpeechCoordinator {
  private readonly textFilter = new TextFilterStream();
  private readonly splitter = new SentenceSplitter();
  private readonly abortController = new AbortController();
  private readonly format: TtsAudioFormat;
  private readonly sentenceTimeoutMs: number;
  private readonly maxBytesPerSentence: number;
  private readonly maxBytesPerTurn: number;
  private readonly disposeExternalAbort?: () => void;
  private chain = Promise.resolve();
  private state: SpeechCoordinatorState = 'accepting';
  private finishPromise?: Promise<{ audio: FinalizedAudio | null }>;
  private abortPromise?: Promise<void>;
  private turnBytes = 0;
  private effectiveExtension: string | null = null;
  private finalizedAudio: FinalizedAudio | null = null;

  constructor(private readonly args: SpeechCoordinatorArgs) {
    this.format = args.format ?? 'mp3';
    this.sentenceTimeoutMs = positiveLimit(args.sentenceTimeoutMs, DEFAULT_SENTENCE_TIMEOUT_MS);
    this.maxBytesPerSentence = positiveLimit(args.maxBytesPerSentence, DEFAULT_MAX_BYTES_PER_SENTENCE);
    this.maxBytesPerTurn = positiveLimit(args.maxBytesPerTurn, DEFAULT_MAX_BYTES_PER_TURN);
    if (args.signal) {
      const abort = (): void => { void this.abort(); };
      if (args.signal.aborted) abort();
      else args.signal.addEventListener('abort', abort, { once: true });
      this.disposeExternalAbort = () => args.signal?.removeEventListener('abort', abort);
    }
  }

  acceptTextDelta(delta: string): void {
    if (this.state !== 'accepting') return;
    const visible = this.textFilter.feed(delta);
    if (!visible) return;
    for (const sentence of this.splitter.feed(visible)) this.enqueue(sentence.index, sentence.text);
  }

  finish(): Promise<{ audio: FinalizedAudio | null }> {
    if (this.finishPromise) return this.finishPromise;
    if (this.state === 'completed') return Promise.resolve({ audio: this.finalizedAudio });
    if (this.state !== 'accepting') return Promise.resolve({ audio: null });
    this.state = 'finishing';
    this.finishPromise = this.finishInternal();
    return this.finishPromise;
  }

  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    if (this.state === 'aborted' || this.state === 'completed') return Promise.resolve();
    this.state = 'aborting';
    this.abortController.abort('speech aborted');
    this.disposeExternalAbort?.();
    this.abortPromise = this.abortInternal();
    return this.abortPromise;
  }

  private async finishInternal(): Promise<{ audio: FinalizedAudio | null }> {
    this.disposeExternalAbort?.();
    const remnant = this.textFilter.flush();
    const tail = [
      ...(remnant ? this.splitter.feed(remnant) : []),
      ...this.splitter.flush(),
    ];
    for (const sentence of tail) this.enqueue(sentence.index, sentence.text);
    await this.chain;
    if (this.state !== 'finishing') return { audio: null };

    if (this.args.archive) {
      try {
        this.finalizedAudio = await this.args.archive.finalizeTurn(
          this.args.sessionId as string,
          this.args.turnId as string,
          this.effectiveExtension ?? this.format,
        );
      } catch (error) {
        this.finalizedAudio = null;
        this.args.emit(warningEvent(
          this.args.sessionId,
          this.args.turnId,
          'tts/audio_archive_failed',
          error,
        ));
      }
    }
    this.state = 'completed';
    return { audio: this.finalizedAudio };
  }

  private async abortInternal(): Promise<void> {
    await this.chain.catch(() => undefined);
    this.args.archive?.discardTurn(this.args.sessionId as string, this.args.turnId as string);
    this.state = 'aborted';
  }

  private enqueue(index: number, text: string): void {
    this.chain = this.chain.then(() => this.synthesizeSentence(index, text)).catch((error: unknown) => {
      if (this.state === 'aborting' || this.state === 'aborted') return;
      this.state = 'failed';
      this.abortController.abort('speech failed');
      this.args.archive?.discardTurn(this.args.sessionId as string, this.args.turnId as string);
      this.args.emit(warningEvent(this.args.sessionId, this.args.turnId, 'tts/coordinator', error));
    });
  }

  private async synthesizeSentence(index: number, sourceText: string): Promise<void> {
    const text = filterSentenceForTts(sourceText);
    // Markdown 或表情清理后没有可朗读文本，就没有发生 TTS 调用，也不能伪造完成事件或 Usage。
    if (!text) return;
    const sentenceId = makeSentenceId(this.args.turnId, index);
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(this.sentenceTimeoutMs);
    const signal = AbortSignal.any([this.abortController.signal, timeoutSignal]);
    let sentenceBytes = 0;
    let writer: SegmentWriter | undefined;
    let errorCode: string | null = null;

    try {
      for await (const event of this.args.textToSpeech.synthesize({
        model: this.args.model,
        text,
        voice: this.args.voice,
        format: this.format,
        signal,
      })) {
        if (this.state !== 'accepting' && this.state !== 'finishing') break;
        if (event.type !== 'audio_chunk') continue;
        sentenceBytes += event.bytes.byteLength;
        this.turnBytes += event.bytes.byteLength;
        if (sentenceBytes > this.maxBytesPerSentence) {
          throw new Error(`TTS sentence exceeded ${this.maxBytesPerSentence} bytes`);
        }
        if (this.turnBytes > this.maxBytesPerTurn) {
          throw new Error(`TTS turn exceeded ${this.maxBytesPerTurn} bytes`);
        }
        if (!writer && this.args.archive) {
          const extension = mimeToExtension(event.mime) ?? this.format;
          this.effectiveExtension ??= extension;
          writer = this.args.archive.openSegment(
            this.args.sessionId as string,
            this.args.turnId as string,
            index,
            extension,
          );
        }
        writer?.write(event.bytes);
        this.args.emit(audioChunkEvent(
          this.args.sessionId,
          this.args.turnId,
          index,
          event.bytes,
          event.mime,
        ));
      }
    } catch (error) {
      if (timeoutSignal.aborted && !this.abortController.signal.aborted) {
        errorCode = 'tts/timeout';
      } else {
        errorCode = errorCodeOf(error);
      }
      if (!this.abortController.signal.aborted) {
        this.args.emit(warningEvent(this.args.sessionId, this.args.turnId, errorCode, error));
      }
    } finally {
      writer?.close();
      this.recordUsage(sentenceId, text.length, startedAt, errorCode);
      if (this.state === 'accepting' || this.state === 'finishing') {
        this.args.emit({
          type: 'tts_sentence_complete',
          sessionId: this.args.sessionId,
          turnId: this.args.turnId,
          sentenceId,
        });
      }
    }
  }

  private recordUsage(
    callId: string,
    characterCount: number,
    startedAt: number,
    errorCode: string | null,
  ): void {
    if (!this.args.usageRecorder) return;
    const record = createUsageRecord({
      capability: 'tts',
      providerId: this.args.providerConfigId,
      modelId: this.args.model,
      status: errorCode === null ? 'completed' : 'failed',
      startedAt,
      durationMs: Date.now() - startedAt,
      usageContext: {
        callId,
        sessionId: this.args.sessionId as string,
        turnId: this.args.turnId as string,
      },
      quantity: characterCount,
      unit: 'character',
      errorCode,
    });
    reportUsage(this.args.usageRecorder, record, this.args.onUsageRecordError);
  }
}

function warningEvent(
  sessionId: string,
  turnId: string,
  code: string,
  error: unknown,
): SpeechEvent {
  return {
    type: 'tts_warning',
    sessionId,
    turnId,
    code,
    severity: code.startsWith('tts/invalid_') || code === 'tts/credentials' ? 'error' : 'warn',
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('tts/') ? code : 'tts/synthesis_failed';
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Speech limits must be positive integers');
  return limit;
}

function mimeToExtension(mime: string): string | null {
  if (mime.startsWith('audio/mpeg')) return 'mp3';
  if (mime.startsWith('audio/wav')) return 'wav';
  if (mime.startsWith('audio/ogg') || mime.startsWith('audio/opus')) return 'ogg';
  if (mime.startsWith('audio/aac')) return 'aac';
  if (mime.startsWith('audio/L16') || mime.startsWith('audio/pcm')) return 'pcm';
  return null;
}
