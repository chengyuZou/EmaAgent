// 统一导出并注册 EmaAgent 自带的工具，也提供这些工具启动恢复所需的入口。
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js';
import { cleanupInterruptedFileWriteTemps } from './tools/FileWriteTool/recovery.js';
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js';
import { GlobTool } from './tools/GlobTool/GlobTool.js';
import { GrepTool } from './tools/GrepTool/GrepTool.js';
import { BashTool } from './tools/BashTool/BashTool.js';
import { PowerShellTool } from './tools/PowerShellTool/PowerShellTool.js';
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
import { ArtifactWriteTool, ArtifactReadTool, ArtifactListTool } from './tools/ArtifactTool/ArtifactTools.js';
import { SkillCallTool } from './tools/SkillCallTool/SkillCallTool.js';
import { KnowledgeBaseSearchTool } from './tools/KnowledgeBaseSearchTool/KnowledgeBaseSearchTool.js';
import { SubagentTool } from './tools/SubagentTool/SubagentTool.js';
import {
  SubagentSpawnBackgroundTool,
  SubagentSendMessageTool,
  SubagentAwaitTool,
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

// ── 单个工具导出 ──────────────────────────────────────────────────────────────

export {
  BuiltinTools,
  FileReadTool,
  FileWriteTool,
  cleanupInterruptedFileWriteTemps,
  FileEditTool,
  GlobTool,
  GrepTool,
  BashTool,
  PowerShellTool,
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
  ArtifactWriteTool,
  ArtifactReadTool,
  ArtifactListTool,
  SkillCallTool,
  KnowledgeBaseSearchTool,
  SubagentTool,
  SubagentSpawnBackgroundTool,
  SubagentSendMessageTool,
  SubagentAwaitTool,
  ScratchpadWriteTool,
  ScratchpadReadTool,
  ScratchpadListTool,
  ScratchpadDeleteTool,
  ScratchpadClearTool,
};
export type { FileReadResult } from './tools/FileReadTool/FileReadTool.js';
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
export type {
  IMcpClientBridge,
  ISkillRunner,
  ISubagentSpawner,
  SubagentRunResult,
  SubagentSpawnOpts,
} from '@ema-agent/tools';

// ── 注册 ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_BUILTIN_TOOLS: BuiltTool<any, any>[] = [
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  BashTool,
  PowerShellTool,
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
  ArtifactWriteTool,
  ArtifactReadTool,
  ArtifactListTool,
  SkillCallTool,
  KnowledgeBaseSearchTool,
  SubagentTool,
  SubagentSpawnBackgroundTool,
  SubagentSendMessageTool,
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
  BuiltinTools.PowerShell.id,
]);

/**
 * Artifact 工具集。V1 默认不注册(Artifact 属于 V1.5 预留能力,
 * 完成状态机 B-003/B-068/B-069 前不得在生产注册)。
 * 源码保留在 ArtifactTool 目录，不删除。
 */
const ARTIFACT_TOOL_IDS: ReadonlySet<string> = new Set([
  BuiltinTools.ArtifactWrite.id,
  BuiltinTools.ArtifactRead.id,
  BuiltinTools.ArtifactList.id,
]);

/**
 * 受运行时桥可用性门禁的工具。
 * key = 稳定工具 id，value = 哪个 RegisterOptions 标志启用它。
 */
const BRIDGE_GATED: ReadonlyMap<string, keyof RegisterOptions> = new Map([
  [BuiltinTools.SkillCall.id,                  'hasSkillBridge'],
  [BuiltinTools.Subagent.id,                   'hasSubagentBridge'],
  [BuiltinTools.SubagentSpawnBackground.id,    'hasSubagentBridge'],
  [BuiltinTools.SubagentSendMessage.id,        'hasSubagentBridge'],
  [BuiltinTools.SubagentAwait.id,              'hasSubagentBridge'],
  [BuiltinTools.TaskCreate.id,                 'hasTaskStore'],
  [BuiltinTools.TaskGet.id,                    'hasTaskStore'],
  [BuiltinTools.TaskList.id,                   'hasTaskStore'],
  [BuiltinTools.TaskUpdate.id,                 'hasTaskStore'],
]);

export interface RegisterOptions {
  /**
   * true 时，Shell 执行工具 Bash、PowerShell 从注册表省略。
   * `CommandRunner.backendName === 'app-layer'`(即无物理沙箱)时设此。
   * 开发时可设 AGEN_UNSAFE_SHELL=1 重新启用。
   */
  disableExecuteTools?: boolean;

  /**
   * 运行时桥可用性标志。桥缺失的工具从注册表省略,LLM 看不到它无法调用的工具。
   * 全部默认 false(工具隐藏)- 仅在 apps/core 接好桥时设 true。
   *
   * SkillCall - SkillRunner 桥
   * Subagent 工具族 - subagent spawner 桥
   *
   * hasMcpBridge 保留(apps/core 仍设它)但不再门禁任何工具:
   * MCP 工具由 McpRegistry 自动展开,不经 mcp_call 暴露。
   */
  hasMcpBridge?:      boolean;
  hasSkillBridge?:    boolean;
  hasSubagentBridge?: boolean;
  /** 根 Work Turn 已装配持久 TaskStore 时才暴露 Task 工具族。 */
  hasTaskStore?:      boolean;
  /**
   * Artifact 工具族是否注册。
   * V1 默认 false(Artifact 属于 V1.5 预留,完成 B-003/B-068/B-069 前不得启用)。
   * 测试或 V1.5 接线时设 true。
   */
  enableArtifacts?:   boolean;
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

    // Artifact 属于 V1.5 预留能力,V1 默认不注册。
    // 完成状态机 B-003/B-068/B-069 前不得启用。
    if (!opts.enableArtifacts && ARTIFACT_TOOL_IDS.has(tool.id)) continue;

    // 运行时桥未接时跳过桥门禁工具。
    // 防止 LLM 看到它实际无法使用的工具。
    const bridgeFlag = BRIDGE_GATED.get(tool.id);
    if (bridgeFlag !== undefined && !opts[bridgeFlag]) continue;

    registry.register(tool);
  }
}
