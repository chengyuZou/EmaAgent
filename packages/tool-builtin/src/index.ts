import type { ToolRegistry, BuiltTool } from '@ema-agent/tool';

// ── Individual tool exports ───────────────────────────────────────────────────

export { fsReadTool } from './tools/fs-read.js';
export type { FsReadResult } from './tools/fs-read.js';

export { fsWriteTool } from './tools/fs-write.js';
export type { FsWriteResult } from './tools/fs-write.js';

export { fsEditTool } from './tools/fs-edit.js';
export type { FsEditResult } from './tools/fs-edit.js';

export { globTool } from './tools/glob.js';
export type { GlobResult } from './tools/glob.js';

export { grepTool } from './tools/grep.js';
export type { GrepResult } from './tools/grep.js';

export { bashTool } from './tools/bash.js';
export type { BashResult } from './tools/bash.js';

export { powershellTool } from './tools/powershell.js';

export { webFetchTool } from './tools/web-fetch.js';
export type { WebFetchResult } from './tools/web-fetch.js';

export { webSearchTool } from './tools/web-search.js';
export type { WebSearchResult, SearchResult } from './tools/web-search.js';

export { todoWriteTool, getTodos, clearTodos } from './tools/todo-write.js';
export type { Todo, TodoWriteResult } from './tools/todo-write.js';

export { askUserTool } from './tools/ask-user.js';
export type { AskUserResult } from './tools/ask-user.js';

export { askConfirmTool } from './tools/ask-confirm.js';
export type { AskConfirmResult } from './tools/ask-confirm.js';

export { askTextTool } from './tools/ask-text.js';
export type { AskTextResult } from './tools/ask-text.js';

export { askChoiceTool } from './tools/ask-choice.js';
export type { AskChoiceResult } from './tools/ask-choice.js';

export { planEnterTool, planExitTool } from './tools/plan-mode.js';
export type { PlanModeResult } from './tools/plan-mode.js';

export { artifactWriteTool, artifactReadTool, artifactListTool } from './tools/artifact.js';

// NOTE: the legacy generic `mcp_call` dispatcher was retired. MCP tools are
// auto-expanded into the registry as `mcp__<server>__<tool>` (see
// McpRegistry.registerMcp), so the model calls them directly — no套娃 dispatcher.
export type { IMcpClientBridge } from '@ema-agent/tool';

export { skillCallTool } from './tools/skill-call.js';
export type { SkillCallResult } from './tools/skill-call.js';
export type { ISkillRunner } from '@ema-agent/tool';

export { subagentTool } from './tools/subagent.js';
export type { SubagentResult } from './tools/subagent.js';
export type { ISubagentSpawner, SubagentSpawnOpts } from '@ema-agent/tool';

export { subagentSpawnBgTool, subagentSendMessageTool, subagentAwaitTool } from './tools/subagent-bg.js';

export { scratchpadWriteTool, scratchpadReadTool, scratchpadListTool, scratchpadDeleteTool, scratchpadClearAllTool } from './tools/scratchpad.js';

// ── Registration ──────────────────────────────────────────────────────────────

import { fsReadTool } from './tools/fs-read.js';
import { fsWriteTool } from './tools/fs-write.js';
import { fsEditTool } from './tools/fs-edit.js';
import { globTool } from './tools/glob.js';
import { grepTool } from './tools/grep.js';
import { bashTool } from './tools/bash.js';
import { powershellTool } from './tools/powershell.js';
import { webFetchTool } from './tools/web-fetch.js';
import { webSearchTool } from './tools/web-search.js';
import { todoWriteTool } from './tools/todo-write.js';
import { askUserTool } from './tools/ask-user.js';
import { askConfirmTool } from './tools/ask-confirm.js';
import { askTextTool } from './tools/ask-text.js';
import { askChoiceTool } from './tools/ask-choice.js';
import { planEnterTool, planExitTool } from './tools/plan-mode.js';
import { artifactWriteTool, artifactReadTool, artifactListTool } from './tools/artifact.js';
import { skillCallTool } from './tools/skill-call.js';
import { subagentTool } from './tools/subagent.js';
import { subagentSpawnBgTool, subagentSendMessageTool, subagentAwaitTool } from './tools/subagent-bg.js';
import { scratchpadWriteTool, scratchpadReadTool, scratchpadListTool, scratchpadDeleteTool, scratchpadClearAllTool } from './tools/scratchpad.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_BUILTIN_TOOLS: BuiltTool<any, any>[] = [
  fsReadTool,
  fsWriteTool,
  fsEditTool,
  globTool,
  grepTool,
  bashTool,
  powershellTool,
  webFetchTool,
  webSearchTool,
  todoWriteTool,
  askUserTool,
  askConfirmTool,
  askTextTool,
  askChoiceTool,
  planEnterTool,
  planExitTool,
  artifactWriteTool,
  artifactReadTool,
  artifactListTool,
  skillCallTool,
  subagentTool,
  subagentSpawnBgTool,
  subagentSendMessageTool,
  subagentAwaitTool,
  scratchpadWriteTool,
  scratchpadReadTool,
  scratchpadListTool,
  scratchpadDeleteTool,
  scratchpadClearAllTool,
];

/** Tools that require a physical OS-level sandbox to be safely exposed. */
const EXECUTE_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell']);

/**
 * Tools gated on a runtime bridge being available.
 * Key = tool name, value = which RegisterOptions flag enables it.
 */
const BRIDGE_GATED: ReadonlyMap<string, keyof RegisterOptions> = new Map([
  ['skill_call',            'hasSkillBridge'],
  ['subagent',              'hasSubagentBridge'],
  ['subagent_spawn_bg',     'hasSubagentBridge'],
  ['subagent_send_message', 'hasSubagentBridge'],
  ['subagent_await',        'hasSubagentBridge'],
]);

export interface RegisterOptions {
  /**
   * When true, shell execution tools (bash, powershell) are omitted from the
   * registry. Set this when `CommandRunner.backendName === 'app-layer'` —
   * i.e. no physical sandbox is available. The tools can be re-enabled by
   * setting AGEN_UNSAFE_SHELL=1 for development.
   */
  disableExecuteTools?: boolean;

  /**
   * Runtime bridge availability flags. Tools whose bridge is absent are
   * omitted from the registry so the LLM never sees tools it cannot call.
   * All default to false (tool hidden) — set to true only when the bridge
   * is wired up in apps/core.
   *
   * skill_call — SkillRunner bridge
   * subagent   — subagent spawner bridge
   *
   * hasMcpBridge is retained (apps/core still sets it) but no longer gates any
   * tool: MCP tools are auto-expanded by McpRegistry, not exposed via mcp_call.
   */
  hasMcpBridge?:      boolean;
  hasSkillBridge?:    boolean;
  hasSubagentBridge?: boolean;
}

/**
 * Register all builtin tools into a ToolRegistry.
 *
 * Called once at app startup by apps/core. Pass `disableExecuteTools: true`
 * when the active sandbox backend is `app-layer` (no OS-level isolation) to
 * prevent the LLM from invoking shell tools without a physical sandbox.
 */
export function registerBuiltinTools(registry: ToolRegistry, opts: RegisterOptions = {}): void {
  for (const tool of ALL_BUILTIN_TOOLS) {
    // Skip execute-class tools when no physical sandbox is available.
    if (opts.disableExecuteTools && EXECUTE_TOOLS.has(tool.name)) continue;

    // Skip bridge-gated tools when their runtime bridge is not wired up.
    // This prevents the LLM from seeing tools it cannot actually use.
    const bridgeFlag = BRIDGE_GATED.get(tool.name);
    if (bridgeFlag !== undefined && !opts[bridgeFlag]) continue;

    registry.register(tool);
  }
}
