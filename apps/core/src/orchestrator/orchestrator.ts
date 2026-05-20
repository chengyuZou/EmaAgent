import type { AppBindings } from '../wiring.js';
import type {
  TurnMode, AgentSubMode, EmaStreamEvent, TurnId,
} from '@ema-agent/contracts';
import type { LlmContentPart } from '@ema-agent/llm';
import { asSessionId } from '@ema-agent/contracts';
import { ConversationEngine } from '@ema-agent/conversation';
import { AgentEngine }        from '@ema-agent/agent';
import { buildSystemPrompt }  from '@ema-agent/prompts';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
}

export interface TurnRequest {
  sessionId:    string;
  mode:         TurnMode;
  subMode?:     AgentSubMode;
  userInput:    string;
  contentParts?: LlmContentPart[];
  model?:       string;
}

/**
 * Orchestrator — picks the right engine for the requested mode and wires it.
 *
 * Holds one ConversationEngine and one AgentEngine instance, reused across
 * turns. Per-session state (CommandRunner, MemoryPlanner indexes) lives in
 * AppBindings, not on these engines.
 */
export class Orchestrator {
  private readonly conversation: ConversationEngine;
  private readonly agent:        AgentEngine;

  constructor(private readonly bindings: AppBindings) {
    this.conversation = new ConversationEngine(bindings);
    this.agent = new AgentEngine({
      session:          bindings.session,
      hooks:            bindings.hooks,
      llm:              bindings.llm,
      emotion:          bindings.emotion,
      tools:            bindings.tools,
      permission:       bindings.permission,
      modelBindings:    bindings.modelBindings,
      getCommandRunner: bindings.getCommandRunner,
    });
  }

  run(request: TurnRequest): TurnResult {
    const sessionId = asSessionId(request.sessionId);
    const { turn, signal } = this.bindings.session.startTurn({
      sessionId,
      mode:         request.mode,
      agentSubMode: request.subMode,
      userInput:    request.userInput,
    });
    const turnId = turn.id;

    const self = this;
    const events = (async function* () {
      switch (request.mode) {
        case 'chat':
        case 'narrative':
          yield* self.conversation.run({
            turn, signal, sessionId,
            mode:         request.mode,
            userInput:    request.userInput,
            contentParts: request.contentParts,
            model:        request.model,
          });
          break;

        case 'agent': {
          // Resolve workspace + system prompt at dispatch time. The prompts
          // hook (priority 10) will re-build a fresh system message inside
          // beforeLlm; we provide a sensible default so embedders without
          // the hook still get a usable prompt.
          const subMode = request.subMode ?? 'full';
          const session = self.bindings.session.getSession(sessionId);
          const workspaceRoot = session.workspaceRoots[0] ?? process.cwd();
          const systemPrompt  = buildSystemPrompt(
            self.bindings.card.current(),
            'agent',
            { agentSubMode: subMode, workspaceRoots: session.workspaceRoots },
          );

          yield* self.agent.run({
            turn, signal, sessionId,
            subMode,
            userInput:             request.userInput,
            contentParts:          request.contentParts,
            systemPrompt,
            workspaceRoot,
            additionalWorkingDirs: session.workspaceRoots.slice(1),
            model:                 request.model,
          });
          break;
        }
      }
    })();

    return { turnId, events };
  }
}
