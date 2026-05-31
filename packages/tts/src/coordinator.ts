import type {
  EmaStreamEvent, TurnId, SessionId, TtsTurnMode,
} from '@ema-agent/contracts';
import type { HookBus, HookContext, HookResult } from '@ema-agent/hook';
import { PRIORITY } from '@ema-agent/hook';

import { TtsClient } from './service.js';
import type { TtsVoiceRef } from './types.js';
import { SentenceSplitter } from './streaming/sentence-splitter.js';
import { TextFilterStream } from './streaming/text-filter.js';
import { ttsEventToEma, makeSentenceId } from './bridge.js';
import type { AudioArchive } from './archive.js';

// ── TtsCoordinator ──────────────────────────────────────────────────────────
//
// A per-turn object that:
//   1. Subscribes to `afterLlmDelta` (PRIORITY.EARLY = 20). Each delta feeds a
//      sentence splitter; completed sentences enter a synthesis queue.
//   2. Drains the queue **sequentially** (concurrency = 1 in V1) — each
//      sentence's audio is fully streamed out before the next starts.
//      Sequential output means the frontend doesn't need to buffer/reorder
//      across sentences; in-order playback is the SSE order.
//   3. Optionally writes each segment to an `AudioArchive` for later merge
//      (turn-complete file at GET /api/turns/:turnId/audio).
//
// Lifecycle:
//   - `start()` registers the hook.
//   - `finish()` unregisters, flushes the splitter, awaits the queue drain,
//     finalizes the archive. Idempotent; safe to call from a `finally` block.
//
// Single-instance per turn. The orchestrator creates and owns it; engines
// never touch it. TTS is "broadcast" — the coordinator never modifies the
// LLM payload, always returns `kind: 'continue'`.

export interface TtsCoordinatorArgs {
  turnId:        TurnId;
  sessionId:     SessionId;
  /** Pre-resolved voice spec (apps/core resolves from character card + binding). */
  voice:         TtsVoiceRef;
  /** provider_configs.id — which TTS provider to use for this turn. */
  providerId:    string;
  /** Model name for the provider (e.g. "tts-1", "cosyvoice-v1"). */
  model:         string;
  /** Business mode ('chat' | 'narrative' | 'agent') — for text filtering only. */
  turnMode?:     TtsTurnMode;
  ttsClient:     TtsClient;
  hooks:         HookBus;
  /** Push an EmaStreamEvent into the merged turn SSE queue. */
  emit:          (event: EmaStreamEvent) => void;
  /** If set, segments + merged file are persisted via this archive. */
  archive?:      AudioArchive;
  /** Default 'mp3'. */
  format?:       'mp3' | 'pcm' | 'wav' | 'opus';
}

export class TtsCoordinator {
  private readonly turnId:      TurnId;
  private readonly sessionId:   SessionId;
  private readonly voice:       TtsVoiceRef;
  private readonly providerId:  string;
  private readonly model:       string;
  private readonly turnMode?:   TtsTurnMode;
  private readonly ttsClient:   TtsClient;
  private readonly hooks:       HookBus;
  private readonly emit:        (event: EmaStreamEvent) => void;
  private readonly archive:     AudioArchive | undefined;
  private readonly format:      'mp3' | 'pcm' | 'wav' | 'opus';

  private readonly textFilter: TextFilterStream;
  private readonly splitter = new SentenceSplitter();
  private unregister: (() => void) | null = null;
  private chain:      Promise<void>       = Promise.resolve();
  private finishing                       = false;
  private finalAudioPath: string | null   = null;

  constructor(args: TtsCoordinatorArgs) {
    this.turnId      = args.turnId;
    this.sessionId   = args.sessionId;
    this.voice       = args.voice;
    this.providerId  = args.providerId;
    this.model       = args.model;
    this.turnMode    = args.turnMode;
    this.ttsClient   = args.ttsClient;
    this.hooks       = args.hooks;
    this.emit        = args.emit;
    this.archive     = args.archive;
    this.format      = args.format ?? 'mp3';
    this.textFilter  = new TextFilterStream(args.turnMode ?? 'chat');
  }

  /** Register the afterLlmDelta hook. Call once at turn start. */
  start(): void {
    if (this.unregister) return;

    const handler = async (
      ctx: HookContext<'afterLlmDelta'>,
    ): Promise<HookResult<'afterLlmDelta'>> => {
      const raw = ctx.payload.delta;
      const filtered = this.textFilter.feed(raw);
      if (filtered) {
        const sentences = this.splitter.feed(filtered);
        for (const s of sentences) {
          console.log(`[tts:sent] idx=${s.index} text="${s.text.slice(0,40)}"`);
          this.enqueue(s.index, s.text);
        }
        if (sentences.length === 0) {
          console.log(`[tts:buf] splitter buffered "${filtered.slice(0, 40)}"`);
        }
      } else if (filtered === '') {
        // Distinguish between "truly empty" and "state machine consumed it"
        console.log(`[tts:skip] filter consumed "${raw.slice(0, 30)}" (state machine absorbed it)`);
      }
      return { kind: 'continue' };
    };

    this.unregister = this.hooks.register('afterLlmDelta', handler, {
      priority: PRIORITY.EARLY,
      name:     'tts:accumulate-delta',
      parallel: true,
    });
  }

  /**
   * Stop accepting new deltas, flush the splitter's trailing buffer, drain
   * the synthesis queue, and finalize the archive. Returns the merged audio
   * path if the archive wrote one.
   */
  async finish(): Promise<{ audioPath: string | null }> {
    if (this.finishing) return { audioPath: this.finalAudioPath };
    this.finishing = true;

    this.unregister?.();
    this.unregister = null;

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

    if (this.archive) {
      try {
        this.finalAudioPath = await this.archive.finalizeTurn(this.turnId as string, this.format);
      } catch {
        // archive failure is non-fatal — audio already streamed live
        this.finalAudioPath = null;
      }
    }

    return { audioPath: this.finalAudioPath };
  }

  /** Discard everything. Used when the turn aborts before completion. */
  async abort(): Promise<void> {
    if (!this.unregister && this.finishing) return;
    this.unregister?.();
    this.unregister = null;
    this.finishing  = true;
    try { await this.chain; } catch { /* swallow */ }
    this.archive?.discardTurn(this.turnId as string);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Chain a new sentence behind any in-flight synthesis. Concurrency = 1 so
   * audio chunks emerge in sentence order. Per-sentence errors are caught and
   * surfaced as `system_warning` events — they don't break the chain.
   */
  private enqueue(index: number, text: string): void {
    this.chain = this.chain.then(() => this.synthesizeOne(index, text)).catch((err) => {
      this.emit({
        type:    'system_warning',
        level:   'warn',
        message: `tts/coordinator: ${(err as Error).message}`,
      });
    });
  }

  private async synthesizeOne(index: number, text: string): Promise<void> {
    const sentenceId = makeSentenceId(this.turnId, index);
    const writer    = this.archive?.openSegment(this.turnId as string, index, this.format);
    let wroteAny    = false;

    try {
      for await (const ev of this.ttsClient.synthesize({
        text,
        providerId: this.providerId,
        model:      this.model,
        voice:      this.voice,
        turnMode:   this.turnMode,
        format:     this.format,
      })) {
        if (ev.type === 'audio_chunk') {
          writer?.write(ev.bytes);
          wroteAny = true;
        }
        const transformed = ttsEventToEma(ev, { turnId: this.turnId, sessionId: this.sessionId }, index);
        if (transformed) this.emit(transformed);
      }

      // Always send a sentence_complete marker, even if the adapter produced
      // no audio (e.g. all-error path). The frontend uses it to detect that
      // the sentence is "done attempting" and won't get more chunks.
      this.emit({ type: 'tts_sentence_complete', sentenceId, sessionId: this.sessionId as string });
    } finally {
      writer?.close();
      if (!wroteAny) {
        // empty segment — clean up to keep the segments dir tidy
        // (archive's discardTurn is for whole turns; per-segment cleanup
        // is not exposed yet — leave the empty file, finalize will skip it
        // because mergeMp3SegmentsByConcat ignores empty buffers).
      }
    }
  }
}
