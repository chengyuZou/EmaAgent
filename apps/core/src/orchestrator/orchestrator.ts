import type { AppBindings } from '../wiring.js';
import type { TurnMode, AgentSubMode, EmaStreamEvent, TurnId } from '@ema-agent/contracts';
import type { LlmContentPart } from '@ema-agent/llm'
import { asSessionId} from '@ema-agent/contracts';
import { runChatTurn } from './conversation-flow.js';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
}

export interface TurnRequest {
  sessionId: string;
  mode: TurnMode;
  subMode?: AgentSubMode;
  userInput: string;
  contentParts?: LlmContentPart[];
  model?: string;
}

/**
 * Orchestrator: picks the right engine for the requested mode and wires it.
 */
export class Orchestrator {
  constructor(private readonly bindings: AppBindings) {}

  run(request: TurnRequest): TurnResult {
    const sessionId = asSessionId(request.sessionId);
    const { turn, signal } = this.bindings.session.startTurn({
      sessionId,
      mode: request.mode,
      agentSubMode: request.subMode,
      userInput: request.userInput,
    })
    const turnId = turn.id;

    const self = this;
    const events = (async function* () {
      switch (request.mode) {
        case 'chat':
          yield* runChatTurn(self.bindings, {
            turn,
            signal,
            sessionId,
            userInput: request.userInput,
            contentParts: request.contentParts,
            model: request.model,
          });
          break;

        case 'narrative':
        case 'agent':
          yield {
            type: 'system_warning',
            level: 'info',
            message: `${request.mode} mode not yet implemented`,
          } satisfies EmaStreamEvent;
          break;
      }
    })();
    return { turnId, events };
  }
}
