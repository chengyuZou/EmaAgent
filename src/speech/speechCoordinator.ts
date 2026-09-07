import type { CallTts, TtsVoice } from '@ema-agent/tts';
import { createUsageRecord, reportUsage } from '@ema-agent/usage';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';
import type { AudioArchive, FinalizedAudio, SegmentWriter } from './audioArchive.js';
import type { SpeechStreamEvent } from './events.js';
import { SentenceSplitter } from './sentenceSplitter.js';
import { filterSentenceForTts, TextFilterStream } from './textFilter.js';

const MAX_BYTES_PER_SENTENCE = 16 * 1024 * 1024;
const SENTENCE_TIMEOUT_MS = 120_000;

export interface SpeechCoordinatorArgs {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly voice: TtsVoice;
  readonly callTts: CallTts;
  readonly emit: (event: SpeechStreamEvent) => void;
  readonly archive: AudioArchive;
  /** Desktop 最多允许三句已生成未播完；达到上限时下一句在这里等待。 */
  readonly waitForPlaybackSlot?: () => Promise<void>;
  readonly signal?: AbortSignal;
  readonly usageRecorder?: UsageRecorder;
  readonly onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

type SpeechCoordinatorState = 'accepting' | 'finishing' | 'completed' | 'aborting' | 'aborted';

/** 一轮语音按句串行合成，因此二进制帧天然属于最近的 sentence_started，不需要重复携带身份。 */
export class SpeechCoordinator {
  private readonly textFilter = new TextFilterStream();
  private readonly splitter = new SentenceSplitter();
  private readonly abortController = new AbortController();
  private readonly disposeExternalAbort?: () => void;
  private chain = Promise.resolve();
  private state: SpeechCoordinatorState = 'accepting';
  private finishPromise?: Promise<{ audio: FinalizedAudio | null }>;
  private abortPromise?: Promise<void>;
  private finalizedAudio: FinalizedAudio | null = null;

  constructor(private readonly args: SpeechCoordinatorArgs) {
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
    this.abortController.abort('speech cancelled');
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

    try {
      this.finalizedAudio = await this.args.archive.finalizeTurn(this.args.sessionId, this.args.turnId);
    } catch (error) {
      console.warn(`[speech] Turn ${this.args.turnId} 最终音频合并失败:`, error);
      this.finalizedAudio = null;
    }
    this.state = 'completed';
    this.args.emit({ type: 'speech_completed', audioAvailable: this.finalizedAudio !== null });
    return { audio: this.finalizedAudio };
  }

  private async abortInternal(): Promise<void> {
    await this.chain.catch(() => undefined);
    this.args.archive.discardTurn(this.args.sessionId, this.args.turnId);
    this.state = 'aborted';
    this.args.emit({ type: 'speech_cancelled' });
  }

  private enqueue(index: number, text: string): void {
    this.chain = this.chain.then(() => this.synthesizeSentence(index, text));
  }

  private async synthesizeSentence(index: number, sourceText: string): Promise<void> {
    const text = filterSentenceForTts(sourceText);
    if (!text || (this.state !== 'accepting' && this.state !== 'finishing')) return;

    const sentenceId = `${this.args.turnId}-${index}`;
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(SENTENCE_TIMEOUT_MS);
    const signal = AbortSignal.any([this.abortController.signal, timeoutSignal]);
    let sentenceBytes = 0;
    let writer: SegmentWriter | undefined;
    let started = false;
    let errorCode: string | null = null;

    try {
      for await (const event of this.args.callTts({
        text,
        voice: this.args.voice,
        format: 'mp3',
        signal,
      })) {
        if (this.state !== 'accepting' && this.state !== 'finishing') break;
        if (event.type !== 'audio_chunk') continue;
        sentenceBytes += event.bytes.byteLength;
        if (sentenceBytes > MAX_BYTES_PER_SENTENCE) {
          throw new Error(`TTS sentence exceeded ${MAX_BYTES_PER_SENTENCE} bytes`);
        }
        if (!writer) writer = this.args.archive.openSegment(this.args.sessionId, this.args.turnId, index);
        if (!started) {
          started = true;
          this.args.emit({ type: 'sentence_started', sentenceId, mime: 'audio/mpeg' });
        }
        writer.write(event.bytes);
        this.args.emit({ type: 'audio_chunk', bytes: event.bytes });
      }
      if (!started || !writer) throw new Error('TTS synthesis produced no audio');
      writer.close();
      this.args.emit({ type: 'sentence_completed', sentenceId });
      await this.args.waitForPlaybackSlot?.();
    } catch (error) {
      writer?.discard();
      errorCode = this.abortController.signal.aborted
        ? 'tts/cancelled'
        : timeoutSignal.aborted
          ? 'tts/timeout'
          : errorCodeOf(error);
      if (this.abortController.signal.aborted) return;
      this.args.emit({
        type: 'sentence_failed',
        sentenceId,
        code: errorCode,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.recordUsage(sentenceId, text.length, startedAt, errorCode);
    }
  }

  private recordUsage(callId: string, characterCount: number, startedAt: number, errorCode: string | null): void {
    if (!this.args.usageRecorder) return;
    const record = createUsageRecord({
      capability: 'tts',
      providerId: this.args.providerId,
      modelId: this.args.modelId,
      status: errorCode === null ? 'completed' : 'failed',
      startedAt,
      durationMs: Date.now() - startedAt,
      usageContext: { callId, sessionId: this.args.sessionId, turnId: this.args.turnId },
      quantity: characterCount,
      unit: 'character',
      errorCode,
    });
    reportUsage(this.args.usageRecorder, record, this.args.onUsageRecordError);
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('tts/') ? code : 'tts/synthesis_failed';
}
