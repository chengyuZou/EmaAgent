import type { AppBindings } from '../wiring.js';
import type { TurnMode, AgentSubMode, EmaStreamEvent } from '@ema-agent/contracts';

export interface TurnRequest {
  turnId: string;
  sessionId: string;
  mode: TurnMode;
  subMode?: AgentSubMode;
  userInput: string;
  attachments?: unknown[];
  model?: string;
}

/**
 * Orchestrator: picks the right engine for the requested mode and wires it.
 *
 * Phase 1 skeleton — returns a stub async generator.
 * ConversationEngine and AgentEngine will be plugged in during Phase 2.
 */
export class Orchestrator {
  constructor(private readonly bindings: AppBindings) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async *run(turn: TurnRequest): AsyncIterable<EmaStreamEvent> {
    // Trigger onTurnStart hooks
    await this.bindings.hooks.trigger('onTurnStart', {
      turnId: turn.turnId as never,
      sessionId: turn.sessionId as never,
      payload: { mode: turn.mode, subMode: turn.subMode },
      emit: () => {},
      abort: () => {},
      meta: {},
    });

    yield {
      type: 'turn_started',
      turnId: turn.turnId as never,
      mode: turn.mode,
      subMode: turn.subMode,
    };

    // Placeholder — engine implementations will replace this
    yield {
      type: 'system_warning',
      level: 'info',
      message: 'Engine not yet implemented (Phase 1 skeleton)',
    };

    yield {
      type: 'turn_completed',
      turnId: turn.turnId as never,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    };

    await this.bindings.hooks.trigger('onTurnEnd', {
      turnId: turn.turnId as never,
      sessionId: turn.sessionId as never,
      payload: { durationMs: 0 },
      emit: () => {},
      abort: () => {},
      meta: {},
    });
  }
}
