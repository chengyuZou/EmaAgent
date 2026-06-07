import type { EmaStreamEvent, EmotionState, TurnId, SessionId } from '@ema-agent/contracts';
import { StreamingActScanner } from './parser.js';
import type { ParsedActTag } from './types.js';
import {
  makeInitialState,
  transitionEmotion,
  toPublicState,
  type EmotionStateInternal,
} from './state-machine.js';

// ── Per-session state ─────────────────────────────────────────────────────────

interface SessionEmotionState {
  state:               EmotionStateInternal;
  scanner:             StreamingActScanner;
  strippedAccumulated: string;
}

// ── EmotionEngine ─────────────────────────────────────────────────────────────

export interface EmotionEngineOptions {
  /** Allowed emotion names from the active character card. */
  vocabulary: string[];
}

/**
 * EmotionEngine — Façade for ACT tag parsing + emotion state machine.
 *
 * One engine instance is shared across ALL sessions in the sidecar (AppBindings
 * holds a singleton). Internal state is keyed by sessionId so concurrent turns
 * in different sessions never interfere.
 *
 * ## Lifecycle per turn
 *
 *   1. `beginTurn(sessionId)` — reset the streaming scanner for this session.
 *      Emotional state is preserved across turns so the character remembers
 *      how she feels between messages.
 *
 *   2. For each LLM `text_delta`:
 *      `processChunk(delta, turnId, sessionId)` → `{ cleaned, events }`
 *
 *   3. After the LLM stream ends:
 *      `flush(turnId, sessionId)` → `{ cleaned, events }`
 *
 * ## Card switch
 *
 *   `reset()` — clears ALL session states back to neutral AND zeroes the scanner.
 *   Call alongside `updateVocabulary()` when the active character card changes.
 *
 * ## Session cleanup
 *
 *   `evictSession(sessionId)` — call when a session is deleted so the internal
 *   map entry is freed. Not required for correctness; purely a memory hygiene.
 */
export class EmotionEngine {
  private vocabulary: readonly string[];
  private readonly sessions = new Map<string, SessionEmotionState>();

  constructor(opts: EmotionEngineOptions) {
    this.vocabulary = opts.vocabulary;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current emotion state for a session, or null if the session has no state yet. */
  current(sessionId: SessionId): EmotionState | null {
    const s = this.sessions.get(sessionId as string);
    return s ? toPublicState(s.state) : null;
  }

  /** Swap vocabulary when the active character card changes. */
  updateVocabulary(vocabulary: string[]): void {
    this.vocabulary = vocabulary;
  }

  /**
   * Prepare for a new turn for the given session.
   * Resets the streaming scanner and per-turn buffer; emotional state is kept.
   */
  beginTurn(sessionId: SessionId): void {
    const existing = this.sessions.get(sessionId as string);
    this.sessions.set(sessionId as string, {
      state:               existing?.state ?? makeInitialState(),
      scanner:             new StreamingActScanner(),
      strippedAccumulated: '',
    });
  }

  /**
   * Full reset — clears ALL session states and scanners back to neutral.
   * Call on character card switch (card is shared across all sessions).
   */
  reset(): void {
    this.sessions.clear();
  }

  /**
   * Release state for a deleted session. Memory hygiene only.
   */
  evictSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId as string);
  }

  /**
   * Process one streaming delta for the given session.
   * Strips ACT tags, updates internal state, and returns:
   *   - `cleaned`: delta text with tags removed
   *   - `events`: SSE events (`emotion_changed`, `stage_cue`) to yield
   */
  processChunk(
    delta:     string,
    turnId:    TurnId,
    sessionId: SessionId,
  ): { cleaned: string; events: EmaStreamEvent[] } {
    const s = this.sessions.get(sessionId as string);
    if (!s) return { cleaned: delta, events: [] };

    const { cleaned, tags } = s.scanner.scan(delta);
    s.strippedAccumulated += cleaned;
    return { cleaned, events: this.tagsToEvents(tags, turnId, sessionId, s) };
  }

  /**
   * Flush any buffered tail at end-of-stream for the given session.
   * Incomplete tags become plain text; no new ACT events on flush.
   */
  flush(
    turnId:    TurnId,
    sessionId: SessionId,
  ): { cleaned: string; events: EmaStreamEvent[] } {
    const s = this.sessions.get(sessionId as string);
    if (!s) return { cleaned: '', events: [] };

    const { cleaned } = s.scanner.flush();
    if (cleaned) s.strippedAccumulated += cleaned;
    void turnId;
    return { cleaned, events: [] };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private tagsToEvents(
    tags:      ParsedActTag[],
    turnId:    TurnId,
    sessionId: SessionId,
    s:         SessionEmotionState,
  ): EmaStreamEvent[] {
    const events: EmaStreamEvent[] = [];

    for (const tag of tags) {
      switch (tag.kind) {
        case 'emotion': {
          const next = transitionEmotion(s.state, tag.value, this.vocabulary);
          if (next !== null) {
            s.state = next;
            events.push({
              type: 'emotion_changed',
              sessionId,
              turnId,
              state: toPublicState(next),
            });
          }
          break;
        }
        case 'motion':
          events.push({
            type: 'stage_cue',
            sessionId,
            turnId,
            cue: { motion: tag.value, priority: 1 },
          });
          break;
        case 'delay': {
          const durationMs = Math.round(parseFloat(tag.value) * 1000);
          events.push({
            type: 'stage_cue',
            sessionId,
            turnId,
            cue: { durationMs, priority: 0 },
          });
          break;
        }
      }
    }

    return events;
  }
}
