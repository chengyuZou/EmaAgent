// 协调单个 Turn 的文本切句、语音合成、前端事件与音频归档。

import type { TurnId, SessionId } from '@ema-agent/ids';
import type { TtsEvent } from './events.js';

import { TtsRuntime } from './ttsRuntime.js';
import type { TtsAudioFormat, TtsVoiceRef } from './types.js';
import { SentenceSplitter } from './streaming/sentenceSplitter.js';
import { TextFilterStream } from './streaming/textFilter.js';
import { ttsEventToTurn, makeSentenceId } from './bridge.js';
import type { AudioArchive, FinalizedAudio } from './archive.js';

// ── TtsCoordinator ──────────────────────────────────────────────────────────
//
// 一个 per-turn 对象,负责:
//   1. 接收 TurnSpeechOutput 观察到的可见 `output_text_delta` 块。
//      每个 delta 喂入句子切分器;完整句子进入合成队列。
//   2. **顺序**排空队列(V1 并发 = 1)- 每句音频完整流完才开始下一句。
//      顺序输出意味着前端无需跨句缓冲/重排;按序播放 = SSE 顺序。
//   3. 可选地把每段写入 `AudioArchive`,供后续合并
//      (turn 完成文件在 GET /api/turns/:turnId/audio)。
//
// 生命周期:
//   - `acceptTextDelta(delta)` 把清洗后的可见文本喂入流。
//   - `finish()` 注销、flush 切分器、等队列排空、归档。幂等;
//     可安全从 `finally` 块调用。
//
// 每个 Turn 单实例，由 TurnSpeechOutput 创建并持有；AgentLoop 不碰。
// TTS 是流式 sidecar，不参与 Turn 生命周期控制。

export interface TtsCoordinatorArgs {
  turnId:        TurnId;
  sessionId:     SessionId;
  /** 预解析的 voice 规格(apps/localHost 从角色卡 + binding 解析)。 */
  voice:         TtsVoiceRef;
  /** provider_configs.id - 本 turn 用哪个 TTS provider。 */
  providerId:    string;
  /** 该 provider 的模型名(如 "tts-1"、"cosyvoice-v1")。 */
  model:         string;
  ttsClient:     TtsRuntime;
  /** 把一个 TTS 事件推入合并的 Turn SSE 队列。 */
  emit:          (event: TtsEvent) => void;
  /** 若设置,分段 + 合并文件经此归档持久化。 */
  archive?:      AudioArchive;
  /**
   * 偏好的输出格式。默认 'mp3'。实际分段扩展名从 adapter 产出的第一个
   * audio_chunk MIME 推断,所以 Qwen-TTS(PCM->WAV 包封后总是交付 WAV)
   * 不管这个提示都写 .wav 分段。
   */
  format?:       TtsAudioFormat;
  /** Turn 级中止信号。用于取消进行中的 provider 请求。 */
  signal?:       AbortSignal;
  /** 单个 Turn 允许归档和推送的最大音频字节数。 */
  maxBytesPerTurn?: number;
}

type TtsCoordinatorState =
  | 'accepting'
  | 'finishing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'failed';

export class TtsCoordinator {
  private readonly turnId:      TurnId;
  private readonly sessionId:   SessionId;
  private readonly voice:       TtsVoiceRef;
  private readonly providerId:  string;
  private readonly model:       string;
  private readonly ttsClient:   TtsRuntime;
  private readonly emit:        (event: TtsEvent) => void;
  private readonly archive:     AudioArchive | undefined;
  private readonly format:      TtsAudioFormat;
  private readonly abortController = new AbortController();
  private readonly disposeExternalAbort: (() => void) | undefined;
  private readonly maxBytesPerTurn: number;

  private readonly textFilter: TextFilterStream;
  private readonly splitter = new SentenceSplitter();
  private chain:      Promise<void>       = Promise.resolve();
  private state: TtsCoordinatorState = 'accepting';
  private finishPromise: Promise<{ audio: FinalizedAudio | null }> | undefined;
  private abortPromise: Promise<void> | undefined;
  private turnBytes = 0;
  private finalAudio: FinalizedAudio | null     = null;
  /**
   * 从第一个 audio_chunk MIME 探测到的实际归档扩展名。
   * 在第一句合成时设置一次;finish() 用它做 finalizeTurn。
   */
  private effectiveExt: string | null = null;

  constructor(args: TtsCoordinatorArgs) {
    this.turnId     = args.turnId;
    this.sessionId  = args.sessionId;
    this.voice      = args.voice;
    this.providerId = args.providerId;
    this.model      = args.model;
    this.ttsClient  = args.ttsClient;
    this.emit       = args.emit;
    this.archive    = args.archive;
    this.format     = args.format ?? 'mp3';
    this.maxBytesPerTurn = args.maxBytesPerTurn ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytesPerTurn) || this.maxBytesPerTurn <= 0) {
      throw new TypeError('TTS maxBytesPerTurn must be a positive safe integer');
    }
    this.textFilter = new TextFilterStream();

    const externalSignal = args.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        this.state = 'aborted';
        this.abortController.abort('aborted');
      } else {
        const onAbort = () => { void this.abort(); };
        externalSignal.addEventListener('abort', onAbort, { once: true });
        this.disposeExternalAbort = () => {
          externalSignal.removeEventListener('abort', onAbort);
        };
      }
    }
  }

  /** 把一个可见 output_text_delta 喂入 turn 作用域的 TTS 管线。 */
  acceptTextDelta(delta: string): void {
    if (this.state !== 'accepting') return;

    const filtered = this.textFilter.feed(delta);
    if (filtered) {
      const sentences = this.splitter.feed(filtered);
      for (const s of sentences) {
        this.enqueue(s.index, s.text);
      }
    }
  }

  /**
   * 停止接收新 delta,flush 切分器尾部缓冲,排空合成队列,归档。
   * 若归档写了合并文件,返回其元数据。
   */
  finish(): Promise<{ audio: FinalizedAudio | null }> {
    if (this.finishPromise) return this.finishPromise;
    if (this.state === 'aborted' || this.state === 'aborting' || this.state === 'failed') {
      return Promise.resolve({ audio: null });
    }
    if (this.state === 'completed') return Promise.resolve({ audio: this.finalAudio });
    this.state = 'finishing';
    this.finishPromise = this.finishInternal();
    return this.finishPromise;
  }

  private async finishInternal(): Promise<{ audio: FinalizedAudio | null }> {
    this.disposeExternalAbort?.();

    // 先 flush 文本过滤器 - 它可能为未闭合块 emit 一个替换词。
    // 再 flush 句子切分器,处理尾部文本。
    const filterRemnant = this.textFilter.flush();
    const tail = [
      ...(filterRemnant ? this.splitter.feed(filterRemnant) : []),
      ...this.splitter.flush(),
    ];
    for (const s of tail) {
      this.enqueue(s.index, s.text);
    }

    await this.chain;

    // 如果等 chain 时调了 abort(),它已设 this.aborted 并会调 discardTurn -
    // 不写半成品合并文件。
    if (this.state !== 'finishing') return { audio: null };

    if (this.archive) {
      try {
        this.finalAudio = await this.archive.finalizeTurn(
          this.sessionId as string,
          this.turnId as string,
          this.effectiveExt ?? this.format,
        );
      } catch {
        // 归档失败非致命 - 音频已实时流式播出
        this.finalAudio = null;
      }
    }

    this.state = 'completed';
    return { audio: this.finalAudio };
  }

  /** 丢弃一切。turn 完成前中止时用。 */
  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    if (this.state === 'aborted' || this.state === 'completed') return Promise.resolve();
    this.state = 'aborting';
    this.abortController.abort('aborted');
    this.disposeExternalAbort?.();
    this.abortPromise = this.abortInternal();
    return this.abortPromise;
  }

  private async abortInternal(): Promise<void> {
    try { await this.chain; } catch (err) {
      console.warn('[tts/coordinator] chain error during abort:', err instanceof Error ? err.message : err);
     }
    this.archive?.discardTurn(this.sessionId as string, this.turnId as string);
    this.state = 'aborted';
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────────

  /**
   * 在进行中的合成后串一句新句。并发 = 1,音频块按句序产出。
   * 单句错误被捕获并以 `tts_warning` 事件上报 - 不打断链。
   */
  private enqueue(index: number, text: string): void {
    this.chain = this.chain.then(() => this.synthesizeOne(index, text)).catch((err) => {
      if (this.state === 'aborting' || this.state === 'aborted') return;
      this.state = 'failed';
      this.abortController.abort('failed');
      this.archive?.discardTurn(this.sessionId as string, this.turnId as string);
      this.emit({
        type:    'tts_warning',
        sessionId: this.sessionId,
        turnId: this.turnId,
        code: 'tts/coordinator',
        severity: 'warn',
        message: `tts/coordinator: ${(err as Error).message}`,
      });
    });
  }

  private async synthesizeOne(index: number, text: string): Promise<void> {
    const sentenceId = makeSentenceId(this.turnId, index);
    // 分段在第一个 audio_chunk 时懒开,以便从块 MIME 推断实际文件扩展名
    // (如 Qwen-TTS 交付 WAV)。
    let writer: ReturnType<NonNullable<typeof this.archive>['openSegment']> | undefined;

    try {
      for await (const ev of this.ttsClient.synthesize({
        text,
        providerId: this.providerId,
        model:      this.model,
        voice:      this.voice,
        format:     this.format,
        abortSignal: this.abortController.signal,
        usageContext: {
          callId: sentenceId,
          sessionId: this.sessionId as string,
          turnId: this.turnId as string,
        },
      })) {
        if (this.state !== 'accepting' && this.state !== 'finishing') break;
        if (ev.type === 'audio_chunk') {
          this.turnBytes += ev.bytes.byteLength;
          if (this.turnBytes > this.maxBytesPerTurn) {
            throw new Error(`TTS turn exceeded ${this.maxBytesPerTurn} bytes`);
          }
          if (!writer && this.archive) {
            const ext = mimeToExt(ev.mime) ?? this.format;
            this.effectiveExt ??= ext;
            writer = this.archive.openSegment(this.sessionId as string, this.turnId as string, index, ext);
          }
          writer?.write(ev.bytes);
        }
        const transformed = ttsEventToTurn(ev, { turnId: this.turnId, sessionId: this.sessionId }, index);
        if (transformed && (this.state === 'accepting' || this.state === 'finishing')) {
          this.emit(transformed);
        }
      }

      // 总是发一个 sentence_complete 标记,即使 adapter 没产出音频
      // (如全错路径)。前端据此判定这句话"已尝试完",不会再有 chunk。
      if (this.state === 'accepting' || this.state === 'finishing') {
        this.emit({ type: 'tts_sentence_complete', turnId: this.turnId, sentenceId, sessionId: this.sessionId });
      }
    } finally {
      writer?.close();
    }
  }
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function mimeToExt(mime: string): string | null {
  if (mime.startsWith('audio/mpeg'))                     return 'mp3';
  if (mime.startsWith('audio/wav'))                      return 'wav';
  if (mime.startsWith('audio/ogg') ||
      mime.startsWith('audio/opus'))                     return 'ogg';
  if (mime.startsWith('audio/aac'))                      return 'aac';
  if (mime.startsWith('audio/L16') ||
      mime.startsWith('audio/pcm'))                      return 'pcm';
  return null;
}
