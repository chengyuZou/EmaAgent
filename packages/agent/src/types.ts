import type { SessionId, EmaStreamEvent, KbSearchResult } from '@ema-agent/contracts';
import type { LlmRouter, LlmContentPart } from '@ema-agent/llm';
import type { SessionStore, Turn } from '@ema-agent/session';
import type { HookBus } from '@ema-agent/hook';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { ICommandRunner, IArtifactStore, IMcpClientBridge, ISkillRunner, ToolRegistry } from '@ema-agent/tool';
import type { PermissionEngine, AskPermissionFn } from '@ema-agent/permission';
import type { AgentFileStateStore, AgentToolResultStore } from '@ema-agent/agent-context';

/** Minimal interface for the AskUser registry — avoids importing from core. */
export interface AskUserRegistryLike {
  create(timeoutMs?: number): { promptId: string; promise: Promise<Record<string, string>> };
  /** Keyed variant: registry uses the caller-supplied promptId, not a new UUID. */
  createWithId(promptId: string, timeoutMs?: number, turnId?: string): { promise: Promise<Record<string, string>> };
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
  /** MCP client bridge — injected so mcp_call tool can dispatch to connected MCP servers. */
  mcpClient?: IMcpClientBridge;
  /** Skill runner bridge — injected so skill_call tool can invoke registered skills. */
  skillRunner?: ISkillRunner;
  /**
   * Knowledge-base search — injected so the kb_search tool can run AgenticRAG.
   * The engine binds the turn's selected assetIds into the toolCtx closure, so
   * the tool itself only passes query + topK. assetIds non-empty → scoped search
   * + use-count bump; omitted → search all global KBs.
   */
  kbSearch?: (query: string, topK?: number, kbIds?: string[], assetIds?: string[], sessionId?: string, turnId?: string) => Promise<KbSearchResult>;
  /**
   * Per-session context store factory. Returns the file-state and tool-result
   * stores for a given session, creating them on first call and caching.
   * Optional so tests and non-agent callers can omit it.
   */
  getContextStores?: (sessionId: SessionId) => {
    fileStateStore:  AgentFileStateStore;
    toolResultStore: AgentToolResultStore;
  };
  /**
   * Task lifecycle store for crash recovery and cross-session task visibility.
   * Optional — omit in tests.
   */
  taskStore?: IAgentTaskStore;
  /** App data directory — used for turn-scoped scratchpad directories. */
  dataDir?: string;
}

// ── IAgentTaskStore — minimal interface avoids hard dep on agent-task ─────────

export interface IAgentTaskStore {
  claim(args: { taskId: string; sessionId: string; turnId: string | null; parentId: string | null }): unknown;
  complete(taskId: string, stats: { iterations: number; inputTokens: number; outputTokens: number }): void;
  fail(taskId: string, reason: string): void;
  cancel(taskId: string, reason: string): void;
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
  /** All workspace roots. First entry is the primary cwd for shell tools. */
  workspaceRoots: string[];
  /** KB id the user was browsing in the chat picker (which KB the kbAssetIds belong to).
   *  Tells kbSearch which KB to target. Omit → active KB. */
  kbId?:       string;
  /** KB documents selected for this turn — scopes kb_search within kbId. */
  kbAssetIds?: string[];
}
