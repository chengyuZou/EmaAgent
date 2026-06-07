import type { EmaStreamEvent, TurnId, SessionId } from '@ema-agent/contracts';
import type { TtsStreamEvent } from './types.js';

// ── TtsStreamEvent → EmaStreamEvent bridge ──────────────────────────────────
//
// `TtsClient` and adapters speak `TtsStreamEvent` (Uint8Array bytes, numeric
// sentence index). The frontend speaks `EmaStreamEvent.tts_chunk` (base64
// audio string, string sentenceId). This module is the only place that
// converts — keep it pure and side-effect-free.
//
// sentenceId format: `<turnId>-<sentenceIndex>` — uniquely identifies a
// sentence's audio within a turn so the frontend can group chunks. After
// reconnect, the frontend can dedupe by sentenceId to avoid replaying
// already-played audio.
//
// sessionId is carried so the frontend's Live2D routing can filter TTS
// events to only the active session. Without it, multi-session TTS would
// all drive the same character simultaneously.

export interface BridgeContext {
  turnId:    TurnId;
  sessionId: SessionId;
}

/**
 * Convert one `TtsStreamEvent` into 0 or 1 `EmaStreamEvent`s. Some internal
 * events (sentence_started, done) have no public counterpart and return
 * `null` — the orchestrator just drops them.
 *
 * Caller is responsible for tracking the current sentence index, since
 * `audio_chunk` doesn't carry one (it belongs to the most-recent
 * sentence_started). Pass `currentSentenceIndex` from the coordinator's
 * per-turn state.
 */
export function ttsEventToEma(
  ev:                    TtsStreamEvent,
  ctx:                   BridgeContext,
  currentSentenceIndex:  number,
): EmaStreamEvent | null {
  switch (ev.type) {
    case 'audio_chunk':
      return {
        type:       'tts_chunk',
        turnId:     ctx.turnId,
        audio:      base64Encode(ev.bytes),
        sentenceId: makeSentenceId(ctx.turnId, currentSentenceIndex),
        sessionId:  ctx.sessionId,
      };

    case 'sentence_done':
      return {
        type:       'tts_sentence_complete',
        turnId:     ctx.turnId,
        sentenceId: makeSentenceId(ctx.turnId, ev.index),
        sessionId:  ctx.sessionId,
      };

    case 'error':
      return {
        type:    'system_warning',
        level:   ev.code.startsWith('permanent_') ? 'error' : 'warn',
        message: `tts/${ev.code}: ${ev.message}`,
      };

    case 'sentence_started':
    case 'done':
      // No 1:1 public event. `sentence_started` is implied by the first
      // following `tts_chunk` with the new sentenceId; `done` is signaled
      // separately by the coordinator after archive finalization.
      return null;
  }
}

export function makeSentenceId(turnId: TurnId, index: number): string {
  return `${turnId as string}-${index}`;
}

export function parseSentenceId(sentenceId: string): { turnId: string; index: number } | null {
  const lastDash = sentenceId.lastIndexOf('-');
  if (lastDash < 0) return null;
  const turnId = sentenceId.slice(0, lastDash);
  const index  = Number.parseInt(sentenceId.slice(lastDash + 1), 10);
  if (!Number.isFinite(index)) return null;
  return { turnId, index };
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Base64 encode a Uint8Array. Uses Node's `Buffer` if available (sidecar
 * runtime), falls back to the standard `btoa` path for tests. Works on
 * arbitrary buffer-backed Uint8Arrays (ArrayBuffer or SharedArrayBuffer).
 */
function base64Encode(bytes: Uint8Array<ArrayBufferLike>): string {
  // Node 20+ — fastest path
  const g = globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (g.Buffer) {
    return g.Buffer.from(bytes).toString('base64');
  }
  // Browser / pure-V8 fallback
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
