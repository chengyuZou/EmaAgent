// 统一导出并注册 EmaAgent 自带的工具，也提供这些工具启动恢复所需的入口。
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js';
import { PdfReadTool } from './tools/PdfReadTool/PdfReadTool.js';
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js';
import { cleanupInterruptedFileWriteTemps } from './tools/FileWriteTool/recovery.js';
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js';
import { GlobTool } from './tools/GlobTool/GlobTool.js';
import { GrepTool } from './tools/GrepTool/GrepTool.js';
import { BashTool } from './tools/BashTool/BashTool.js';
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js';
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js';
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js';
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js';
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js';
import { AskUserTool } from './tools/AskUserTool/AskUserTool.js';
import { AskConfirmTool } from './tools/AskUserTool/AskConfirmTool.js';
import { AskTextTool } from './tools/AskUserTool/AskTextTool.js';
import { AskChoiceTool } from './tools/AskUserTool/AskChoiceTool.js';
import { SkillCallTool } from './tools/SkillCallTool/SkillCallTool.js';
import { KnowledgeBaseSearchTool } from './tools/KnowledgeBaseSearchTool/KnowledgeBaseSearchTool.js';
import { NarrativeSearchTool } from './tools/NarrativeSearchTool/NarrativeSearchTool.js';
import { SubagentTool } from './tools/SubagentTool/SubagentTool.js';
import {
  SubagentSpawnBackgroundTool,
  SubagentSendMessageTool,
  SubagentAwaitTool,
  SubagentAbortTool,
} from './tools/SubagentTool/BackgroundSubagentTools.js';
import {
  ScratchpadWriteTool,
  ScratchpadReadTool,
  ScratchpadListTool,
  ScratchpadDeleteTool,
  ScratchpadClearTool,
} from './tools/ScratchpadTool/ScratchpadTools.js';
import { BuiltinTools } from './BuiltinToolIdentity.js';
import type { ToolRegistry, BuiltTool } from '@ema-agent/tools';

// ── 宿主 Context 与装配 ──────────────────────────────────────────────────────
export type { BuiltinToolContext, ScratchpadPort, AskUserPort } from './builtinToolContext.js';
export type {
  SubagentContextMode,
  SubagentRunResult,
  SubagentSpawnOptions,
  SubagentSpawnerPort,
} from './subagentToolPort.js';
export { assembleToolPool } from './assembleToolPool.js';
export { contextOk, contextFail } from './contextValidation.js';

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
  WebFetchTool,
  WebSearchTool,
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  AskUserTool,
  AskConfirmTool,
  AskTextTool,
  AskChoiceTool,
  SkillCallTool,
  KnowledgeBaseSearchTool,
  NarrativeSearchTool,
  SubagentTool,
  SubagentSpawnBackgroundTool,
  SubagentSendMessageTool,
  SubagentAwaitTool,
  SubagentAbortTool,
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
export type { WebFetchResult } from './tools/WebFetchTool/WebFetchTool.js';
export type { WebSearchResult, SearchResult } from './tools/WebSearchTool/WebSearchTool.js';
export type { TaskCreateResult } from './tools/TaskCreateTool/TaskCreateTool.js';
export type { TaskGetResult } from './tools/TaskGetTool/TaskGetTool.js';
export type {
  TaskListItem,
  TaskListResult,
} from './tools/TaskListTool/TaskListTool.js';
export type { TaskUpdateResult } from './tools/TaskUpdateTool/TaskUpdateTool.js';
export type { AskUserResult } from './tools/AskUserTool/AskUserTool.js';
export type { AskConfirmResult } from './tools/AskUserTool/AskConfirmTool.js';
export type { AskTextResult } from './tools/AskUserTool/AskTextTool.js';
export type { AskChoiceResult } from './tools/AskUserTool/AskChoiceTool.js';
export type { SkillCallResult } from './tools/SkillCallTool/SkillCallTool.js';
export type { NarrativeSearchResult } from './tools/NarrativeSearchTool/NarrativeSearchTool.js';
// ── 注册 ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_BUILTIN_TOOLS: BuiltTool<any, any, any>[] = [
  FileReadTool,
  PdfReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  BashTool,
  WebFetchTool,
  WebSearchTool,
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  AskUserTool,
  AskConfirmTool,
  AskTextTool,
  AskChoiceTool,
  SkillCallTool,
  KnowledgeBaseSearchTool,
  NarrativeSearchTool,
  SubagentTool,
  SubagentSpawnBackgroundTool,
  SubagentSendMessageTool,
  SubagentAwaitTool,
  SubagentAbortTool,
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

export interface RegisterOptions {
  /**
   * true 时，Shell 执行工具 Bash 从注册表省略。
   * `CommandRunner.backendName === 'app-layer'`(即无物理沙箱)时设此。
   * 开发时可设 AGEN_UNSAFE_SHELL=1 重新启用。
   */
  disableExecuteTools?: boolean;
}

/**
 * 把所有内置工具注册进 ToolRegistry。
 *
 * apps/core 在应用启动时调一次。当前 sandbox 后端为 `app-layer`
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
