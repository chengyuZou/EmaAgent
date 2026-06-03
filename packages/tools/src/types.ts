import type { z } from 'zod';
import type {
  EmaStreamEvent, Artifact, ArtifactId, ArtifactType, SessionId, TurnId,
} from '@ema-agent/contracts';
import type { ToolPermissionMeta } from '@ema-agent/permission';

// ── ReadFileState — shared dedup cache across tool calls within a turn ────────

export interface ReadFileEntry {
  /** Full file content at time of read, for edit anti-overwrite check. */
  content: string;
  /** mtime in milliseconds at time of read. */
  timestamp: number;
  /** undefined when the full file was read (no pagination). */
  offset?: number;
  limit?: number;
  /** True when offset/limit was specified — edit must refuse a partial-view read. */
  isPartialView: boolean;
}

/** Keyed by absolute, normalized file path. */
export type ReadFileState = Map<string, ReadFileEntry>;

// ── IFileStateStore — interface only (implemented by @ema-agent/agent-context) ──
//
// Defined here so tools (fs_read, fs_edit) can call it without importing the
// agent-context package (avoids tools → agent-context → … cycle).

export interface IFileStateStoreEntry {
  content:       string;
  mtimeMs:       number;
  offset?:       number;
  limit?:        number;
  isPartialView: boolean;
}

export interface IFileStateStore {
  record(path: string, entry: IFileStateStoreEntry): void;
  get(path: string): (IFileStateStoreEntry & { lastAccessMs: number }) | undefined;
  recentEntries(limit: number): ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
}

// ── IArtifactStore — interface only (implemented by @ema-agent/artifact) ───────
//
// Thin interface so tools can write artifacts without importing the artifact
// package directly (avoids a tools → artifact → storage cycle).

export interface ArtifactUpsertArgs {
  id?:       ArtifactId;
  sessionId: SessionId;
  turnId?:   TurnId;
  type:      ArtifactType;
  title:     string;
  content:   string;
  meta?:     Record<string, unknown>;
}

export interface IArtifactStore {
  upsert(args: ArtifactUpsertArgs): Artifact;
  get(id: ArtifactId): Artifact | null;
  /** Metadata-only list — content field omitted for efficiency. */
  list(sessionId: SessionId, opts?: { type?: string }): Omit<Artifact, 'content'>[];
  apply(id: ArtifactId, targetPath: string): Artifact;
  reject(id: ArtifactId): Artifact;
  delete(id: ArtifactId): void;
  /** Returns true when session has >100 artifacts — tool should surface a warning. */
  countWarning(sessionId: SessionId): boolean;
}

// ── ICommandRunner — interface only (implemented by @ema-agent/sandbox) ───────

/**
 * Thin interface so tools can call the sandbox runner without importing the
 * sandbox package directly (avoids circular deps: tools ↛ sandbox ↛ permission).
 */
export interface RunOptions {
  cwd?:        string;
  timeout?:    number;
  signal?:     AbortSignal;
  /** Fire-and-forget: spawn detached, return immediately with empty result. */
  background?: boolean;
}

export interface RunResult {
  stdout:    string;
  stderr:    string;
  exitCode:  number;
  timedOut:  boolean;
  truncated: boolean;
}

export interface ICommandRunner {
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /** Remove bare-repo attack files planted by the previous command. */
  cleanup(): void;
  /** Re-derive sandbox config after permission rules change. */
  refreshConfig(): void;
  /** Human-readable reason if OS sandboxing degraded to app-layer. */
  getSandboxUnavailableReason(): string | undefined;
  /**
   * Teardown any persistent sandbox resources (e.g. a long-lived bwrap namespace).
   * No-op in V1 (process-per-command model). Reserved for V2 persistent sandbox.
   */
  destroy?(): void;
}

// ── ToolExecutionContext ───────────────────────────────────────────────────────

export interface ToolExecutionContext {
  sessionId: string;
  turnId: string;
  /** Absolute path to the user's active workspace / project root. */
  workspaceRoot: string;
  /** Additional dirs the agent may read/write (beyond workspaceRoot). */
  additionalWorkingDirs?: string[];
  /** Per-turn cancellation signal — tools must honour this for long-running ops. */
  signal: AbortSignal;
  /**
   * Shared mtime-dedup cache for file reads/edits within the current turn.
   * Persists across tool calls so fs_edit can verify the file was read first.
   */
  readFileState: ReadFileState;
  /**
   * Per-session persistent file state store (AgentFileStateStore).
   * Survives across turns — used for cross-turn stale-edit detection and
   * post-compact restore. Absent in tests and non-agent callers.
   */
  fileStateStore?: IFileStateStore;
  /**
   * Emit a structured SSE event mid-execution (e.g. tool_result from sub-steps).
   * Optional: not all call-sites provide a streaming channel.
   */
  emit?: (event: EmaStreamEvent) => void;
  /**
   * Sandbox-backed shell runner. When present, bash tool delegates execution
   * here instead of spawning directly — gets OS-level sandboxing for free.
   */
  commandRunner?: ICommandRunner;
  /**
   * Ask the user a set of questions mid-tool and await their answers.
   * Provided by the engine when an AskUserRegistry is wired up; absent in
   * tests and minimal embedders that don't support interactive prompts.
   * `promptId` must match the id already broadcast in `ask_user_required`.
   */
  askUser?: (promptId: string, questions: unknown[]) => Promise<{ answers: Record<string, string> }>;
  /**
   * Persistent artifact store. When present, artifact_write/read/list delegate
   * here instead of the in-process memory fallback.
   */
  artifactStore?: IArtifactStore;
}

// ── ToolDescriptor — what the LLM sees ───────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema derived from the Zod input schema via zodToJsonSchema(). */
  inputJsonSchema: Record<string, unknown>;
}

// ── ToolDef — the raw definition authors write ────────────────────────────────

export interface ToolDef<TInput, TOutput> {
  name: string;
  description: string;
  // ZodType<Output, Def, Input> — we relax the input side to unknown because
  // ZodDefault and ZodOptional produce `T | undefined` on the input side, which
  // would cause assignability failures when TInput has all defaults applied.
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;

  /** True → read-only, safe to auto-allow in any permission mode. */
  isReadOnly: () => boolean;
  /**
   * True → multiple instances may run in parallel within the same turn.
   * Set false for tools that write shared state (session store, file system).
   */
  isConcurrencySafe: () => boolean;

  /** Permission metadata consulted by PermissionEngine.gate(). */
  permissionMeta: ToolPermissionMeta;

  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}

// ── BuiltTool — sealed, registry-ready form ───────────────────────────────────

export interface BuiltTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  readonly isReadOnly: () => boolean;
  readonly isConcurrencySafe: () => boolean;
  readonly permissionMeta: ToolPermissionMeta;
  readonly descriptor: () => ToolDescriptor;
  readonly execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
  /**
   * Type-erased execute for registry dispatch — input must be pre-validated
   * by parseInput() before calling this.
   */
  readonly unsafeExecute: (input: unknown, ctx: ToolExecutionContext) => Promise<unknown>;
  /** Parse + validate raw LLM args (throws ZodError on failure). */
  readonly parseInput: (raw: unknown) => TInput;
}
