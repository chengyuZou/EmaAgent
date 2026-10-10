import type { CallTts, PcmAudioFormat, TtsVoice } from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';
import type { AudioWriter, FinalizedAudio, FsAudioArchive } from './audioArchive.js';
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
  readonly archive: FsAudioArchive;
  readonly signal: AbortSignal;
  readonly usageRecorder: UsageRecorder;
  /** 第一块 PCM 写入成功后调用一次; 此时音频 HTTP 路由已可读取. */
  readonly onAudioReady: () => void;
  readonly onSentenceError: (error: {
    readonly code: string;
    readonly message: string;
  }) => void;
}

export type SpeechGenerationResult =
  | {
      readonly status: 'completed' | 'cancelled';
      readonly audio: FinalizedAudio | null;
    }
  | {
      readonly status: 'failed';
      readonly audio: FinalizedAudio | null;
      readonly code: string;
      readonly message: string;
    };

type SpeechCoordinatorState = 'accepting' | 'finishing' | 'cancelled' | 'failed' | 'completed';

export class SpeechCoordinator {
  private readonly textFilter = new TextFilterStream();
  private readonly splitter = new SentenceSplitter();
  private readonly abortController = new AbortController();
  private readonly onExternalAbort = (): void => {
    void this.cancel();
  };
  private chain = Promise.resolve();
  private state: SpeechCoordinatorState = 'accepting';
  private completion: Promise<SpeechGenerationResult> | null = null;
  private writer: AudioWriter | null = null;
  private format: PcmAudioFormat | null = null;
  private audioReady = false;
  private failure: { code: string; message: string } | null = null;

  constructor(private readonly args: SpeechCoordinatorArgs) {
    args.signal.addEventListener('abort', this.onExternalAbort, { once: true });
    if (args.signal.aborted) void this.cancel();
  }

  acceptTextDelta(delta: string): void {
    if (this.state !== 'accepting') return;
    const visible = this.textFilter.feed(delta);
    for (const sentence of this.splitter.feed(visible)) {
      this.enqueue(sentence.index, sentence.text);
    }
  }

  finish(): Promise<SpeechGenerationResult> {
    if (this.completion) return this.completion;
    if (this.state === 'accepting') {
      this.state = 'finishing';
      const remnant = this.textFilter.flush();
      const tail = [
        ...this.splitter.feed(remnant),
        ...this.splitter.flush(),
      ];
      for (const sentence of tail) {
        this.enqueue(sentence.index, sentence.text);
      }
    }
    this.completion = this.finishInternal();
    return this.completion;
  }

  cancel(): Promise<SpeechGenerationResult> {
    if (this.state === 'completed') return this.completion!;
    if (this.state !== 'failed') this.state = 'cancelled';
    this.abortController.abort('speech cancelled');
    // finish 已经在等待合成时, 取消仍要立即中断请求, 然后共用同一次文件保存.
    this.completion ??= this.finishInternal();
    return this.completion;
  }

  private async finishInternal(): Promise<SpeechGenerationResult> {
    await this.chain;
    let audio: FinalizedAudio | null = null;
    try {
      audio = await this.writer?.finish() ?? null;
    } catch (error) {
      this.failure = {
        code: 'speech/audio_archive_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.args.signal.removeEventListener('abort', this.onExternalAbort);
    }
    const cancelled = this.state === 'cancelled';
    this.state = 'completed';
    if (this.failure) return { status: 'failed', audio, ...this.failure };
    return { status: cancelled ? 'cancelled' : 'completed', audio };
  }

  private enqueue(index: number, text: string): void {
    this.chain = this.chain
      .then(() => this.synthesizeSentence(index, text))
      .catch(error => {
        this.failure = {
          code: 'speech/generate_failed',
          message: error instanceof Error ? error.message : String(error),
        };
        this.state = 'failed';
        this.abortController.abort(error);
      });
  }

  private async synthesizeSentence(index: number, sourceText: string): Promise<void> {
    const text = filterSentenceForTts(sourceText);
    if (!text || (this.state !== 'accepting' && this.state !== 'finishing')) return;

    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(SENTENCE_TIMEOUT_MS);
    const signal = AbortSignal.any([this.abortController.signal, timeoutSignal]);
    let sentenceBytes = 0;
    let sentenceFormat: PcmAudioFormat | null = null;
    let fileFailed = false;
    let errorCode: string | null = null;
    try {
      for await (const event of this.args.callTts({
        text,
        voice: this.args.voice,
        signal,
      })) {
        signal.throwIfAborted();
        if (event.type === 'audio_started') {
          sentenceFormat = { sampleRate: event.sampleRate, channelCount: event.channelCount };
        } else if (event.type === 'audio_chunk') {
          sentenceBytes += event.bytes.byteLength;
          if (sentenceBytes > MAX_BYTES_PER_SENTENCE) {
            throw new Error(`TTS sentence exceeded ${MAX_BYTES_PER_SENTENCE} bytes`);
          }
          try {
            await this.writeAudio(event.bytes, sentenceFormat!, signal);
          } catch (error) {
            fileFailed = !signal.aborted;
            throw error;
          }
        }
      }
      signal.throwIfAborted();
      if (sentenceBytes === 0) throw new Error('TTS synthesis produced no audio');
    } catch (error) {
      if (this.abortController.signal.aborted) {
        errorCode = 'tts/cancelled';
        return;
      }
      errorCode = timeoutSignal.aborted ? 'tts/timeout' : errorCodeOf(error);
      // 供应商某句失败可以继续下一句; 文件写入失败或 PCM 格式改变则不能继续追加.
      if (fileFailed) throw error;
      this.args.onSentenceError({
        code: errorCode,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.recordUsage(`${this.args.turnId}-${index}`, text.length, startedAt, errorCode);
    }
  }

  private async writeAudio(
    bytes: Uint8Array,
    format: PcmAudioFormat,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.writer) {
      this.writer = await this.args.archive.openTurn(this.args.sessionId, this.args.turnId, format);
      this.format = format;
    } else if (format.sampleRate !== this.format!.sampleRate
      || format.channelCount !== this.format!.channelCount) {
      throw new Error('TTS PCM format changed within one audio file');
    }
    signal.throwIfAborted();
    await this.writer.write(bytes);
    if (!this.audioReady) {
      this.audioReady = true;
      this.args.onAudioReady();
    }
  }

  private recordUsage(callId: string, characterCount: number, startedAt: number, errorCode: string | null): void {
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    if (errorCode === 'tts/cancelled' || errorCode === 'tts/aborted') status = 'cancelled';
    else if (errorCode !== null) status = 'failed';
    this.args.usageRecorder.record({
      id: callId,
      sessionId: this.args.sessionId,
      turnId: this.args.turnId,
      capability: 'tts',
      providerId: this.args.providerId,
      modelId: this.args.modelId,
      status,
      durationMs: Date.now() - startedAt,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: characterCount,
      unit: 'character',
      errorCode,
      createdAt: startedAt,
    });
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('tts/') ? code : 'tts/synthesis_failed';
}
