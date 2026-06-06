import type { EmaStreamEvent, EmotionState, TurnId } from '@ema-agent/contracts';
import { StreamingActScanner } from './parser.js';
import type { ParsedActTag } from './types.js';
import {
  makeInitialState,
  transitionEmotion,
  toPublicState,
  type EmotionStateInternal,
} from './state-machine.js';

// ── EmotionEngine ─────────────────────────────────────────────────────────────

export interface EmotionEngineOptions {
  /** Allowed emotion names from the active character card. */
  vocabulary: string[];
}

/**
 * EmotionEngine — Façade for ACT tag parsing + emotion state machine.
 *
 * ## Lifecycle per turn
 *
 *   1. `beginTurn()` — reset the streaming scanner and per-turn accumulated
 *      buffer. Emotional state is intentionally preserved across turns so the
 *      character "remembers" how they feel between messages.
 *
 *   2. For each LLM `text_delta`:
 *      `processChunk(delta, turnId)` → `{ cleaned, events }`
 *      - `cleaned` is the delta with ACT tags stripped; yield it as
 *        `output_text_delta` and accumulate into `fullText`.
 *      - `events` are zero or more `emotion_changed` / `stage_cue` SSE events
 *        ready to yield directly to the frontend.
 *
 *   3. After the LLM stream ends:
 *      `flush(turnId)` → `{ cleaned, events }`
 *      Releases any buffered tail from an incomplete tag (model stopped
 *      mid-tag). Incomplete tags become plain text; no new ACT events.
 *
 * ## Card switch / session reset
 *
 *   `reset()` — zeroes scanner, accumulated buffer, AND emotional state back
 *   to neutral. Also call `updateVocabulary()` with the new card's vocabulary.
 *
 * ## Why not HookBus
 *
 *   ACT tag stripping is a mid-stream data transform (one delta in → cleaned
 *   delta + N events out). Engines must apply it inline before yielding
 *   output_text_delta; sidecar consumers such as TTS only see the cleaned
 *   visible text. Direct call is the correct pattern here.
 */
export class EmotionEngine {
  private vocabulary: readonly string[];
  private state: EmotionStateInternal;
  /** Cleaned accumulated text for the current turn (ACT tags stripped). */
  private strippedAccumulated = '';
  private readonly scanner = new StreamingActScanner();

  constructor(opts: EmotionEngineOptions) {
    this.vocabulary = opts.vocabulary;
    this.state = makeInitialState();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current emotion state (survives across turns). */
  current(): EmotionState {
    return toPublicState(this.state);
  }

  /** Swap vocabulary when the active character card changes. */
  updateVocabulary(vocabulary: string[]): void {
    this.vocabulary = vocabulary;
  }

  /**
   * Prepare for a new turn.
   * Resets the streaming scanner and per-turn buffer; emotional state is kept.
   */
  beginTurn(): void {
    this.scanner.reset();
    this.strippedAccumulated = '';
  }

  /**
   * Full reset — scanner, accumulated buffer, and emotional state → neutral.
   * Use on character card switch or explicit session reset.
   */
  reset(): void {
    this.scanner.reset();
    this.strippedAccumulated = '';
    this.state = makeInitialState();
  }

  /**
   * Process one streaming delta.
   * Strips ACT tags, updates internal state, and returns:
   *   - `cleaned`: delta text with tags removed (may be empty if delta was
   *     entirely tags or a partial-tag buffer flush held the text)
   *   - `events`: SSE events (`emotion_changed`, `stage_cue`) to yield
   */
  processChunk(
    delta: string,
    turnId: TurnId,
  ): { cleaned: string; events: EmaStreamEvent[] } {
    const { cleaned, tags } = this.scanner.scan(delta);
    this.strippedAccumulated += cleaned;
    return { cleaned, events: this.tagsToEvents(tags, turnId) };
  }

  /**
   * Flush any buffered tail at end-of-stream.
   * An incomplete tag at the end of a stream (model stopped mid-tag) is
   * returned as plain text. No new ACT events are produced on flush.
   */
  flush(turnId: TurnId): { cleaned: string; events: EmaStreamEvent[] } {
    const { cleaned } = this.scanner.flush();
    if (cleaned) this.strippedAccumulated += cleaned;
    // Incomplete tags treated as plain text — no tag events on flush.
    void turnId;
    return { cleaned, events: [] };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private tagsToEvents(
    tags: ParsedActTag[],
    turnId: TurnId,
  ): EmaStreamEvent[] {
    const events: EmaStreamEvent[] = [];

    for (const tag of tags) {
      switch (tag.kind) {
        case 'emotion': {
          const next = transitionEmotion(this.state, tag.value, this.vocabulary);
          if (next !== null) {
            this.state = next;
            events.push({
              type: 'emotion_changed',
              turnId,
              state: toPublicState(next),
            });
          }
          break;
        }
        case 'motion':
          events.push({
            type: 'stage_cue',
            turnId,
            cue: { motion: tag.value, priority: 1 },
          });
          break;
        case 'delay': {
          const durationMs = Math.round(parseFloat(tag.value) * 1000);
          events.push({
            type: 'stage_cue',
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
