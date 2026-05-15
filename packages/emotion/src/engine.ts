import type { EmaStreamEvent, EmotionState } from '@ema-agent/contracts';
import type { HookBus } from '@ema-agent/hook';
import { StreamingActScanner } from './parser.js';
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
 * EmotionEngine — the Façade for ACT tag parsing + emotion state machine.
 *
 * Lifecycle:
 *   1. Construct once per app (or per card switch), passing the card vocabulary.
 *   2. Call `registerHooks(bus, emit)` to wire into the HookBus.
 *      `emit` is the per-request SSE emitter so the engine can push
 *      `emotion_changed` and `stage_cue` events to the frontend.
 *   3. On turn start the engine resets its per-turn scanner automatically via
 *      the `onTurnStart` hook.
 *
 * Hook registrations:
 *   - `afterLlmDelta` (priority 5, serial): parse ACT tags, strip them from
 *     the delta, emit side-channel events, return `replace` with cleaned text.
 *   - `onTurnStart`   (priority 5, serial): reset the streaming scanner.
 */
export class EmotionEngine {
  private vocabulary: readonly string[];
  private state: EmotionStateInternal;
  /** Stripped accumulated text for the current turn (reset on each turn). */
  private strippedAccumulated = '';
  private readonly scanner = new StreamingActScanner();

  constructor(opts: EmotionEngineOptions) {
    this.vocabulary = opts.vocabulary;
    this.state = makeInitialState();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  current(): EmotionState {
    return toPublicState(this.state);
  }

  updateVocabulary(vocabulary: string[]): void {
    this.vocabulary = vocabulary;
  }

  reset(): void {
    this.scanner.reset();
    this.strippedAccumulated = '';
    this.state = makeInitialState();
  }

  // ── Hook registration ───────────────────────────────────────────────────────

  /**
   * Register all emotion hooks on the bus.
   *
   * @param bus  The application HookBus.
   * @param emit Per-request SSE emitter. The caller must swap this out each
   *             turn because the emitter is bound to the current SSE response.
   * @returns    Cleanup function — call to unregister all hooks.
   */
  registerHooks(
    bus: HookBus,
    getEmit: () => ((event: EmaStreamEvent) => void) | undefined,
  ): () => void {
    const unsubDelta = bus.register(
      'afterLlmDelta',
      (ctx) => {
        const { cleaned, tags } = this.scanner.scan(ctx.payload.delta);
        this.strippedAccumulated += cleaned;

        const emit = getEmit() ?? ctx.emit;

        for (const tag of tags) {
          if (tag.kind === 'emotion') {
            const next = transitionEmotion(this.state, tag.value, this.vocabulary);
            if (next !== null) {
              this.state = next;
              emit?.({
                type: 'emotion_changed',
                state: toPublicState(next),
              });
            }
          } else if (tag.kind === 'motion') {
            emit?.({
              type: 'stage_cue',
              cue: { motion: tag.value, priority: 1 },
            });
          } else if (tag.kind === 'delay') {
            const durationMs = Math.round(parseFloat(tag.value) * 1000);
            emit?.({
              type: 'stage_cue',
              cue: { durationMs, priority: 0 },
            });
          }
        }

        return {
          kind: 'replace',
          payload: {
            delta: cleaned,
            accumulated: this.strippedAccumulated,
          },
        };
      },
      { name: 'emotion:actParser', priority: 5 },
    );

    const unsubTurnStart = bus.register(
      'onTurnStart',
      (_ctx) => {
        this.scanner.reset();
        this.strippedAccumulated = '';
        return { kind: 'continue' };
      },
      { name: 'emotion:resetOnTurnStart', priority: 5 },
    );

    return () => {
      unsubDelta();
      unsubTurnStart();
    };
  }
}
