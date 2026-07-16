// 这里统一导出并注册 EmaAgent 自带的工具，也提供这些工具启动恢复所需的入口。
import type { ToolRegistry, BuiltTool } from '@ema-agent/tools';

// ── 单个工具导出 ──────────────────────────────────────────────────────────────

export { BuiltinTools } from './BuiltinToolIdentity.js';

export { FileReadTool } from './tools/FileReadTool/FileReadTool.js';
export type { FileReadResult } from './tools/FileReadTool/FileReadTool.js';

export { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js';
export type { FileWriteResult } from './tools/FileWriteTool/FileWriteTool.js';
export { cleanupInterruptedFileWriteTemps } from './tools/FileWriteTool/recovery.js';

export { FileEditTool } from './tools/FileEditTool/FileEditTool.js';
export type { FileEditResult } from './tools/FileEditTool/FileEditTool.js';

export { GlobTool } from './tools/GlobTool/GlobTool.js';
export type { GlobResult } from './tools/GlobTool/GlobTool.js';

export { GrepTool } from './tools/GrepTool/GrepTool.js';
export type { GrepResult } from './tools/GrepTool/GrepTool.js';

export { bashTool } from './tools/bash.js';
export type { BashResult } from './tools/bash.js';

export { powershellTool } from './tools/powershell.js';

export { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js';
export type { WebFetchResult } from './tools/WebFetchTool/WebFetchTool.js';

export { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js';
export type { WebSearchResult, SearchResult } from './tools/WebSearchTool/WebSearchTool.js';

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

export { artifactWriteTool, artifactReadTool, artifactListTool } from './tools/artifact.js';

// NOTE:旧的通用 `mcp_call` 分发器已退役。MCP 工具自动展开进注册表为
// `mcp__<server>__<tool>`(见 McpRegistry.registerMcp),模型直接调用 -
// 不需要套娃分发器。
export type { IMcpClientBridge } from '@ema-agent/tools';

export { skillCallTool } from './tools/skill-call.js';
export type { SkillCallResult } from './tools/skill-call.js';
export type { ISkillRunner } from '@ema-agent/tools';

export { kbSearchTool } from './tools/kb-search.js';

export { subagentTool } from './tools/subagent.js';
export type { SubagentResult } from './tools/subagent.js';
export type { ISubagentSpawner, SubagentSpawnOpts } from '@ema-agent/tools';

export { subagentSpawnBgTool, subagentSendMessageTool, subagentAwaitTool } from './tools/subagent-bg.js';

export { scratchpadWriteTool, scratchpadReadTool, scratchpadListTool, scratchpadDeleteTool, scratchpadClearAllTool } from './tools/scratchpad.js';

// ── 注册 ──────────────────────────────────────────────────────────────────────

import { FileReadTool } from './tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js';
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js';
import { GlobTool } from './tools/GlobTool/GlobTool.js';
import { GrepTool } from './tools/GrepTool/GrepTool.js';
import { bashTool } from './tools/bash.js';
import { powershellTool } from './tools/powershell.js';
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js';
import { todoWriteTool } from './tools/todo-write.js';
import { askUserTool } from './tools/ask-user.js';
import { askConfirmTool } from './tools/ask-confirm.js';
import { askTextTool } from './tools/ask-text.js';
import { askChoiceTool } from './tools/ask-choice.js';
import { artifactWriteTool, artifactReadTool, artifactListTool } from './tools/artifact.js';
import { skillCallTool } from './tools/skill-call.js';
import { kbSearchTool } from './tools/kb-search.js';
import { subagentTool } from './tools/subagent.js';
import { subagentSpawnBgTool, subagentSendMessageTool, subagentAwaitTool } from './tools/subagent-bg.js';
import { scratchpadWriteTool, scratchpadReadTool, scratchpadListTool, scratchpadDeleteTool, scratchpadClearAllTool } from './tools/scratchpad.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_BUILTIN_TOOLS: BuiltTool<any, any>[] = [
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  bashTool,
  powershellTool,
  WebFetchTool,
  WebSearchTool,
  todoWriteTool,
  askUserTool,
  askConfirmTool,
  askTextTool,
  askChoiceTool,
  artifactWriteTool,
  artifactReadTool,
  artifactListTool,
  skillCallTool,
  kbSearchTool,
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

/** 需要物理 OS 级沙箱才能安全暴露的工具。 */
const EXECUTE_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell']);

/**
 * Artifact 工具集。V1 默认不注册(Artifact 属于 V1.5 预留能力,
 * 完成状态机 B-003/B-068/B-069 前不得在生产注册)。
 * 源码保留(packages/tool-builtin/src/tools/artifact.ts),不删除。
 */
const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  'artifact_write',
  'artifact_read',
  'artifact_list',
]);

/**
 * 受运行时桥可用性门禁的工具。
 * key = 工具名,value = 哪个 RegisterOptions 标志启用它。
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
   * true 时,shell 执行工具(bash、powershell)从注册表省略。
   * `CommandRunner.backendName === 'app-layer'`(即无物理沙箱)时设此。
   * 开发时可设 AGEN_UNSAFE_SHELL=1 重新启用。
   */
  disableExecuteTools?: boolean;

  /**
   * 运行时桥可用性标志。桥缺失的工具从注册表省略,LLM 看不到它无法调用的工具。
   * 全部默认 false(工具隐藏)- 仅在 apps/core 接好桥时设 true。
   *
   * skill_call - SkillRunner 桥
   * subagent   - subagent spawner 桥
   *
   * hasMcpBridge 保留(apps/core 仍设它)但不再门禁任何工具:
   * MCP 工具由 McpRegistry 自动展开,不经 mcp_call 暴露。
   */
  hasMcpBridge?:      boolean;
  hasSkillBridge?:    boolean;
  hasSubagentBridge?: boolean;
  /**
   * Artifact 工具(artifact_write/read/list)是否注册。
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
    if (opts.disableExecuteTools && EXECUTE_TOOLS.has(tool.name)) continue;

    // Artifact 属于 V1.5 预留能力,V1 默认不注册。
    // 完成状态机 B-003/B-068/B-069 前不得启用。
    if (!opts.enableArtifacts && ARTIFACT_TOOLS.has(tool.name)) continue;

    // 运行时桥未接时跳过桥门禁工具。
    // 防止 LLM 看到它实际无法使用的工具。
    const bridgeFlag = BRIDGE_GATED.get(tool.name);
    if (bridgeFlag !== undefined && !opts[bridgeFlag]) continue;

    registry.register(tool);
  }
}
