import type { SessionId, TurnMode, AgentSubMode, LlmProtocol } from '@ema-agent/contracts';
import type { LlmRouter } from '@ema-agent/llm';
import type { LlmContentPart } from '@ema-agent/llm';
import type { SessionStore, Turn } from '@ema-agent/session';
import type { HookBus } from '@ema-agent/hook';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { NarrativeClient } from '@ema-agent/narrative-client';
import type { ModelBindingsRepo } from '@ema-agent/storage';

// ── Dependency surface ────────────────────────────────────────────────────────

/**
 * Everything ConversationEngine needs — a strict subset of AppBindings.
 * Both apps/core (Hono sidecar) and the future CLI can satisfy this interface
 * without pulling in HTTP-layer concerns.
 */
export interface ConversationDeps {
  session:       SessionStore;
  hooks:         HookBus;
  llm:           LlmRouter;
  emotion:       EmotionEngine;
  narrative:     NarrativeClient;
  modelBindings: ModelBindingsRepo;
}

// ── Run input ─────────────────────────────────────────────────────────────────

export interface ConversationRunInput {
  /** Already-started turn (caller is responsible for session.startTurn). */
  turn:          Turn;
  /** Abort signal wired from session.startTurn — fires on user Stop. */
  signal:        AbortSignal;
  sessionId:     SessionId;
  /** 'chat' or 'narrative'; agent is handled by AgentEngine. */
  mode:          Exclude<TurnMode, 'agent'>;
  userInput:     string;
  contentParts?: LlmContentPart[];
  /** Explicit model override; falls back to model_bindings for the mode. */
  model?:        string;
  /** LLM protocol for content-part validation. Defaults to 'openai-llm'. */
  protocol?:     LlmProtocol;
}
