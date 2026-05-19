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

export { planEnterTool, planExitTool } from './tools/plan-mode.js';
export type { PlanModeResult } from './tools/plan-mode.js';

export { artifactWriteTool, artifactReadTool, artifactListTool } from './tools/artifact.js';

export { mcpCallTool } from './tools/mcp-call.js';
export type { McpCallResult, McpClientBridge } from './tools/mcp-call.js';

export { skillCallTool } from './tools/skill-call.js';
export type { SkillCallResult, SkillRunner } from './tools/skill-call.js';

export { subagentTool } from './tools/subagent.js';
export type { SubagentResult, SubagentSpawner } from './tools/subagent.js';

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
import { planEnterTool, planExitTool } from './tools/plan-mode.js';
import { artifactWriteTool, artifactReadTool, artifactListTool } from './tools/artifact.js';
import { mcpCallTool } from './tools/mcp-call.js';
import { skillCallTool } from './tools/skill-call.js';
import { subagentTool } from './tools/subagent.js';

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
  planEnterTool,
  planExitTool,
  artifactWriteTool,
  artifactReadTool,
  artifactListTool,
  mcpCallTool,
  skillCallTool,
  subagentTool,
];

/**
 * Register all builtin tools into a ToolRegistry.
 *
 * Called once at app startup by apps/core before the first turn is processed.
 * On Windows, powershell is always registered (it will throw at runtime on non-Windows).
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of ALL_BUILTIN_TOOLS) {
    registry.register(tool);
  }
}
