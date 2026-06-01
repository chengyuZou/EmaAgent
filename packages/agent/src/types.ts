import type { SessionId, AgentSubMode, EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmRouter, LlmContentPart } from '@ema-agent/llm';
import type { SessionStore, Turn } from '@ema-agent/session';
import type { HookBus } from '@ema-agent/hook';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { ICommandRunner, IArtifactStore, ToolRegistry } from '@ema-agent/tool';
import type { PermissionEngine, AskPermissionFn } from '@ema-agent/permission';

/** Minimal interface for the AskUser registry — avoids importing from core. */
export interface AskUserRegistryLike {
  create(timeoutMs?: number): { promptId: string; promise: Promise<Record<string, string>> };
  /** Keyed variant: registry uses the caller-supplied promptId, not a new UUID. */
  createWithId(promptId: string, timeoutMs?: number): { promise: Promise<Record<string, string>> };
  respond(promptId: string, answers: Record<string, string>): boolean;
}

// ── Dependency surface ────────────────────────────────────────────────────────

/**
 * Everything AgentEngine needs — a strict subset of AppBindings.
 * No imports from ConversationEngine; the two engines share nothing but types.
 *
 * Deliberately excludes model_bindings: provider + model resolution is the
 * orchestrator's job, not the engine's. The engine receives a resolved
 * providerId + model via AgentRunInput.
 */
export interface AgentDeps {
  session:    SessionStore;
  hooks:      HookBus;
  llm:        LlmRouter;
  emotion:    EmotionEngine;
  tools:      ToolRegistry;
  permission: PermissionEngine;
  /**
   * Per-session sandbox runner factory. Returning undefined disables sandboxing
   * (bash will spawn directly). The orchestrator caches one CommandRunner per
   * sessionId — workspaceRoot differs across sessions so a singleton won't work.
   * Optional so tests can omit it entirely.
   */
  getCommandRunner?: (sessionId: SessionId) => ICommandRunner | undefined;
  /**
   * Factory that builds a per-turn askPermission callback wired to the turn's
   * SSE event stream. Tests can omit it (PermissionEngine then falls back to
   * its constructor `ask` config — typically a deny-all stub).
   */
  buildAsk?: (args: {
    sessionId: SessionId;
    turnId:    string;
    emit:      (ev: EmaStreamEvent) => void;
  }) => AskPermissionFn;
  /**
   * Registry for pending ask_user prompts. The engine injects a resolver into
   * toolCtx that the ask_user tool awaits.
   */
  askUserRegistry?: AskUserRegistryLike;
  /** Persistent artifact store — injected so artifact_write/read/list persist across turns. */
  artifactStore?: IArtifactStore;
}

// ── Run input ─────────────────────────────────────────────────────────────────

/**
 * Per-turn call arguments. All routing decisions (which provider, which model)
 * must be resolved by the orchestrator before calling engine.run() — the engine
 * is a pure executor.
 */
export interface AgentRunInput {
  /** Already-started turn (caller is responsible for session.startTurn). */
  turn:                  Turn;
  /** Abort signal wired from session.startTurn — fires on user Stop. */
  signal:                AbortSignal;
  subMode:               AgentSubMode;
  /**
   * User message content. Plain string for text-only turns; LlmContentPart[]
   * for multimodal (image, audio, file). These are two shapes of the same
   * concept — the engine picks them apart via Array.isArray.
   */
  userInput:             string | LlmContentPart[];
  /** Pre-built system prompt (assembled by orchestrator). */
  systemPrompt:          string;
  /** Resolved provider_configs.id — orchestrator responsibility. */
  providerId:            string;
  /** Resolved model name — orchestrator responsibility. */
  model:                 string;
  /** Absolute path to the user's active workspace root. */
  workspaceRoot:         string;
  additionalWorkingDirs?: string[];
}
