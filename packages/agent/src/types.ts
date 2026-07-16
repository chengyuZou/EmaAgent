import type {
  SessionId,
  EmaStreamEvent,
  KbSearchResult,
  KbAssetScope,
  RequestDegradationNotice,
  ToolCallId,
  TurnId,
} from '@ema-agent/contracts';
import type { LlmRouter, LlmContentPart, LlmMessage, ThinkingMode } from '@ema-agent/llm';
import type { SessionStore, Turn } from '@ema-agent/session';
import type { HookBus } from '@ema-agent/hook';
import type { EmotionEngine } from '@ema-agent/emotion';
import type { ICommandRunner, IArtifactStore, IMcpClientBridge, ISkillRunner, ToolRegistry } from '@ema-agent/tools';
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
    turnId:    TurnId;
    toolCallId: ToolCallId;
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
   * kbIds: which KBs to search ([] / undefined → active KB). Supplied by the LLM tool call.
   * assetScopes: per-KB doc filters from the chat picker (user selection, not LLM).
   * Engine closure passes assetScopes only when the tool does NOT supply kbIds.
   */
  kbSearch?: (query: string, topK?: number, kbIds?: string[], assetScopes?: KbAssetScope[], sessionId?: string, turnId?: string) => Promise<KbSearchResult>;
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
  /** 工具副作用的持久化状态机；生产环境由 agent-task Facade 注入。 */
  toolExecutionJournal?: IToolExecutionJournal;
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
  /** Resolved provider_configs.id — orchestrator responsibility. */
  providerId:            string;
  /** Resolved model name — orchestrator responsibility. */
  model:                 string;
  /** The workspace root. Empty string = no workspace (subagent). */
  workspaceRoot: string;
  /** KB ids the user selected in the chat picker. kbSearch searches across all of them.
   *  [] / omit → falls back to the active KB. */
  kbIds?:         string[];
  /** Per-KB doc scopes from the chat picker — narrows search within each KB.
   *  KBs without a matching scope are searched unfiltered. */
  kbAssetScopes?: KbAssetScope[];
  /**
   * Per-iteration compaction callback. Called at the top of every agentLoop
   * iteration before the LLM call so multi-step agent turns don't overflow
   * the context window mid-turn. Orchestrator wires this to MemoryPlanner.compact().
   * Omit in tests and sub-agent spawns (ephemeral context).
   */
  compactMessages?: (messages: LlmMessage[]) => Promise<LlmMessage[]>;
  /** User-requested thinking mode — forwarded to every LlmRequest in the agent loop. */
  thinking?: ThinkingMode;
  /** Core 在 Engine 前完成的媒体降级。 */
  requestDegradations?: RequestDegradationNotice[];
}

// ── IToolExecutionJournal — Agent 只依赖 Facade 契约 ─────────────────────────

export interface IToolExecutionJournal {
  prepare(args: {
    callId: ToolCallId;
    sessionId: SessionId;
    turnId: TurnId;
    toolName: string;
    input: unknown;
  }): unknown;
  authorize(callId: ToolCallId): unknown;
  start(callId: ToolCallId): unknown;
  succeed(callId: ToolCallId, output: unknown): unknown;
  fail(callId: ToolCallId, errorCode: string, errorMessage: string): unknown;
  cancel(callId: ToolCallId, reason: string): unknown;
  outcomeUnknown(callId: ToolCallId, reason: string): unknown;
}
