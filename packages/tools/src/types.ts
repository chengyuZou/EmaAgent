import type { z } from 'zod';
import type { EmaStreamEvent } from '@ema-agent/contracts';
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
   * Emit a structured SSE event mid-execution (e.g. tool_result from sub-steps).
   * Optional: not all call-sites provide a streaming channel.
   */
  emit?: (event: EmaStreamEvent) => void;
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
