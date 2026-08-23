// 统一导出并注册 EmaAgent 自带的工具，也提供这些工具启动恢复所需的入口。
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js';
import { PdfReadTool } from './tools/PdfReadTool/PdfReadTool.js';
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js';
import { cleanupInterruptedFileWriteTemps } from './tools/FileWriteTool/recovery.js';
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js';
import { GlobTool } from './tools/GlobTool/GlobTool.js';
import { GrepTool } from './tools/GrepTool/GrepTool.js';
import { BashTool } from './tools/BashTool/BashTool.js';
import { PowerShellTool } from './tools/PowerShellTool/PowerShellTool.js';
import { ProcessListTool } from './tools/ProcessListTool/ProcessListTool.js';
import { ProcessOutputTool } from './tools/ProcessOutputTool/ProcessOutputTool.js';
import { ProcessStopTool } from './tools/ProcessStopTool/ProcessStopTool.js';
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js';
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js';
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js';
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js';
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js';
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js';
import { AskUserTool } from './tools/AskUserTool/AskUserTool.js';
import { MemorySearchTool } from './tools/MemoryTool/MemorySearchTool.js';
import { MemoryReadTool } from './tools/MemoryTool/MemoryReadTool.js';
import { MemoryListTool } from './tools/MemoryTool/MemoryListTool.js';
import { MemoryNoteTool } from './tools/MemoryTool/MemoryNoteTool.js';
import { SkillTool } from './tools/SkillTool/SkillTool.js';
import { KnowledgeBaseSearchTool } from './tools/KnowledgeBaseSearchTool/KnowledgeBaseSearchTool.js';
import { NarrativeSearchTool } from './tools/NarrativeSearchTool/NarrativeSearchTool.js';
import { SubagentTool } from './tools/SubagentTool/SubagentTool.js';
import { SubagentAwaitTool } from './tools/SubagentTool/SubagentAwaitTool.js';
import {
  ScratchpadWriteTool,
  ScratchpadReadTool,
  ScratchpadListTool,
  ScratchpadDeleteTool,
  ScratchpadClearTool,
} from './tools/ScratchpadTool/ScratchpadTools.js';
import { BuiltinTools } from './BuiltinToolIdentity.js';
import type { ToolRegistry, Tool } from '@ema-agent/tools';

// ── 宿主 Context 与装配 ──────────────────────────────────────────────────────
export type {
  AskUser,
  ToolUseContext,
  Scratchpad,
  SubagentContextMode,
  SubagentRunResult,
  SubagentSpawnOptions,
  SubagentSpawnerFn,
} from '@ema-agent/tools';
export { contextOk, contextFail } from '@ema-agent/tools';

// ── 单个工具导出 ──────────────────────────────────────────────────────────────

export {
  BuiltinTools,
  FileReadTool,
  PdfReadTool,
  FileWriteTool,
  cleanupInterruptedFileWriteTemps,
  FileEditTool,
  GlobTool,
  GrepTool,
  BashTool,
  PowerShellTool,
  ProcessListTool,
  ProcessOutputTool,
  ProcessStopTool,
  WebFetchTool,
  WebSearchTool,
  TodoWriteTool,
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  AskUserTool,
  SkillTool,
  KnowledgeBaseSearchTool,
  NarrativeSearchTool,
  MemorySearchTool,
  MemoryReadTool,
  MemoryListTool,
  MemoryNoteTool,
  SubagentTool,
  SubagentAwaitTool,
  ScratchpadWriteTool,
  ScratchpadReadTool,
  ScratchpadListTool,
  ScratchpadDeleteTool,
  ScratchpadClearTool,
};
export type { FileReadResult } from './tools/FileReadTool/FileReadTool.js';
export type {
  PdfReadResult,
  PdfReadWarning,
} from './tools/PdfReadTool/PdfReadTool.js';
export type { FileWriteResult } from './tools/FileWriteTool/FileWriteTool.js';
export type { FileEditResult } from './tools/FileEditTool/FileEditTool.js';
export type { GlobResult } from './tools/GlobTool/GlobTool.js';
export type { GrepResult } from './tools/GrepTool/GrepTool.js';
export type { BashResult } from './tools/BashTool/BashTool.js';
export type { PowerShellCommandResult } from './tools/PowerShellTool/PowerShellTool.js';
export type { ProcessListResult } from './tools/ProcessListTool/ProcessListTool.js';
export type { ProcessOutputResult } from './tools/ProcessOutputTool/ProcessOutputTool.js';
export type { ProcessStopResult } from './tools/ProcessStopTool/ProcessStopTool.js';
export type { WebFetchResult } from './tools/WebFetchTool/WebFetchTool.js';
export type { WebSearchResult, SearchResult } from './tools/WebSearchTool/WebSearchTool.js';
export type {
  TodoItem,
  TodoWriteInput,
  TodoWriteResult,
} from './tools/TodoWriteTool/TodoWriteTool.js';
export type { TaskCreateResult } from './tools/TaskCreateTool/TaskCreateTool.js';
export type { TaskGetResult } from './tools/TaskGetTool/TaskGetTool.js';
export type {
  TaskListItem,
  TaskListResult,
} from './tools/TaskListTool/TaskListTool.js';
export type { TaskUpdateResult } from './tools/TaskUpdateTool/TaskUpdateTool.js';
export type { AskUserResult } from './tools/AskUserTool/AskUserTool.js';
export type { MemoryReadToolResult } from './tools/MemoryTool/MemoryReadTool.js';
export type { MemoryNoteToolResult } from './tools/MemoryTool/MemoryNoteTool.js';
export type { SkillToolResult } from './tools/SkillTool/SkillTool.js';
export type { NarrativeSearchResult } from './tools/NarrativeSearchTool/NarrativeSearchTool.js';
// ── 注册 ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_BUILTIN_TOOLS: Tool<any, any, any, any>[] = [
  FileReadTool,
  PdfReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  BashTool,
  PowerShellTool,
  ProcessListTool,
  ProcessOutputTool,
  ProcessStopTool,
  WebFetchTool,
  WebSearchTool,
  TodoWriteTool,
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  AskUserTool,
  SkillTool,
  KnowledgeBaseSearchTool,
  NarrativeSearchTool,
  MemorySearchTool,
  MemoryReadTool,
  MemoryListTool,
  MemoryNoteTool,
  SubagentTool,
  SubagentAwaitTool,
  ScratchpadWriteTool,
  ScratchpadReadTool,
  ScratchpadListTool,
  ScratchpadDeleteTool,
  ScratchpadClearTool,
];

/** 需要物理 OS 级沙箱才能安全暴露的工具。 */
const EXECUTE_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.Bash.id,
]);
// PowerShell 刻意不在此列:它的安全由 AST 静态分析 + 逐条权限提供,正是为
// 无沙箱 Windows 准备的执行面(TODO #8 的放行路线);可用性由 validateContext
// 按 pwsh/powershell 探测结果门控,与沙箱后端无关。

export interface RegisterOptions {
  /**
   * true 时，Shell 执行工具 Bash 从注册表省略。
   * 后端探测为 `unisolated`(即无物理沙箱)时由 Server 设置。
   * 开发时可设 AGEN_UNSAFE_SHELL=1 重新启用。
   */
  disableExecuteTools?: boolean;
}

/**
 * 把所有内置工具注册进 ToolRegistry。
 *
 * apps/server 在应用启动时调一次。当前 sandbox 后端为 `unisolated`
 * (无 OS 级隔离)时传 `disableExecuteTools: true`,防止 LLM 在无物理
 * 沙箱时调 shell 工具。
 */
export function registerBuiltinTools(registry: ToolRegistry, opts: RegisterOptions = {}): void {
  for (const tool of ALL_BUILTIN_TOOLS) {
    // 无物理沙箱时跳过执行类工具。
    if (opts.disableExecuteTools && EXECUTE_TOOL_IDS.has(tool.id)) continue;

    registry.register(tool);
  }
}
