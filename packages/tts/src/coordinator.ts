import type {
  EmaStreamEvent, TurnId, SessionId,
} from '@ema-agent/contracts';

import { TtsClient } from './service.js';
import type { TtsVoiceRef } from './types.js';
import { SentenceSplitter } from './streaming/sentence-splitter.js';
import { TextFilterStream } from './streaming/text-filter.js';
import { ttsEventToEma, makeSentenceId } from './bridge.js';
import type { AudioArchive, FinalizedAudio } from './archive.js';

// ── TtsCoordinator ──────────────────────────────────────────────────────────
//
// A per-turn object that:
//   1. Receives visible `output_text_delta` chunks from apps/core orchestrator.
//      Each delta feeds a sentence splitter; completed sentences enter a
//      synthesis queue.
//   2. Drains the queue **sequentially** (concurrency = 1 in V1) — each
//      sentence's audio is fully streamed out before the next starts.
//      Sequential output means the frontend doesn't need to buffer/reorder
//      across sentences; in-order playback is the SSE order.
//   3. Optionally writes each segment to an `AudioArchive` for later merge
//      (turn-complete file at GET /api/turns/:turnId/audio).
//
// Lifecycle:
//   - `acceptTextDelta(delta)` feeds cleaned visible text into the stream.
//   - `finish()` unregisters, flushes the splitter, awaits the queue drain,
//     finalizes the archive. Idempotent; safe to call from a `finally` block.
//
// Single-instance per turn. The orchestrator creates and owns it; engines
// never touch it. TTS is a stream sidecar, not a HookBus participant.

export interface TtsCoordinatorArgs {
  turnId:        TurnId;
  sessionId:     SessionId;
  /** Pre-resolved voice spec (apps/core resolves from character card + binding). */
  voice:         TtsVoiceRef;
  /** provider_configs.id — which TTS provider to use for this turn. */
  providerId:    string;
  /** Model name for the provider (e.g. "tts-1", "cosyvoice-v1"). */
  model:         string;
  ttsClient:     TtsClient;
  /** Push an EmaStreamEvent into the merged turn SSE queue. */
  emit:          (event: EmaStreamEvent) => void;
  /** If set, segments + merged file are persisted via this archive. */
  archive?:      AudioArchive;
  /**
   * Preferred output format. Defaults to 'mp3'. The actual segment extension
   * is inferred from the first audio_chunk MIME emitted by the adapter, so
   * Qwen-TTS (which always delivers WAV after PCM→WAV wrapping) writes .wav
   * segments regardless of this hint.
   */
  format?:       'mp3' | 'pcm' | 'wav' | 'opus';
  /** Turn-level abort signal. Used to cancel in-flight provider requests. */
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
  private readonly ttsClient:   TtsClient;
  private readonly emit:        (event: EmaStreamEvent) => void;
  private readonly archive:     AudioArchive | undefined;
  private readonly format:      'mp3' | 'pcm' | 'wav' | 'opus';
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
   * Actual archive extension detected from the first audio_chunk MIME.
   * Set once on the first synthesized sentence; used by finish() for finalizeTurn.
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

  /** Feed one visible output_text_delta into the turn-scoped TTS pipeline. */
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
   * Stop accepting new deltas, flush the splitter's trailing buffer, drain
   * the synthesis queue, and finalize the archive. Returns the merged audio
   * metadata if the archive wrote one.
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

    // Flush the text filter first — it may emit a code-replacement string for
    // an unclosed block. Then flush the sentence splitter for any trailing text.
    const filterRemnant = this.textFilter.flush();
    const tail = [
      ...(filterRemnant ? this.splitter.feed(filterRemnant) : []),
      ...this.splitter.flush(),
    ];
    for (const s of tail) {
      this.enqueue(s.index, s.text);
    }

    await this.chain;

    // If abort() was called while we were waiting for the chain, it has already
    // set this.aborted and will call discardTurn — don't write a partial merged file.
    if (this.state !== 'finishing') return { audio: null };

    if (this.archive) {
      try {
        this.finalAudio = await this.archive.finalizeTurn(
          this.sessionId as string,
          this.turnId as string,
          this.effectiveExt ?? this.format,
        );
      } catch {
        // archive failure is non-fatal — audio already streamed live
        this.finalAudio = null;
      }
    }

    this.state = 'completed';
    return { audio: this.finalAudio };
  }

  /** Discard everything. Used when the turn aborts before completion. */
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

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Chain a new sentence behind any in-flight synthesis. Concurrency = 1 so
   * audio chunks emerge in sentence order. Per-sentence errors are caught and
   * surfaced as `system_warning` events — they don't break the chain.
   */
  private enqueue(index: number, text: string): void {
    this.chain = this.chain.then(() => this.synthesizeOne(index, text)).catch((err) => {
      if (this.state === 'aborting' || this.state === 'aborted') return;
      this.state = 'failed';
      this.abortController.abort('failed');
      this.archive?.discardTurn(this.sessionId as string, this.turnId as string);
      this.emit({
        type:    'system_warning',
        level:   'warn',
        message: `tts/coordinator: ${(err as Error).message}`,
      });
    });
  }

  private async synthesizeOne(index: number, text: string): Promise<void> {
    const sentenceId = makeSentenceId(this.turnId, index);
    // Segment is opened lazily on the first audio_chunk so we can infer the
    // actual file extension from the chunk's MIME (e.g. Qwen-TTS delivers WAV).
    let writer: ReturnType<NonNullable<typeof this.archive>['openSegment']> | undefined;

    try {
      for await (const ev of this.ttsClient.synthesize({
        text,
        providerId: this.providerId,
        model:      this.model,
        voice:      this.voice,
        format:     this.format,
        abortSignal: this.abortController.signal,
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
        const transformed = ttsEventToEma(ev, { turnId: this.turnId, sessionId: this.sessionId }, index);
        if (transformed && (this.state === 'accepting' || this.state === 'finishing')) {
          this.emit(transformed);
        }
      }

      // Always send a sentence_complete marker, even if the adapter produced
      // no audio (e.g. all-error path). The frontend uses it to detect that
      // the sentence is "done attempting" and won't get more chunks.
      if (this.state === 'accepting' || this.state === 'finishing') {
        this.emit({ type: 'tts_sentence_complete', turnId: this.turnId, sentenceId, sessionId: this.sessionId });
      }
    } finally {
      writer?.close();
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
