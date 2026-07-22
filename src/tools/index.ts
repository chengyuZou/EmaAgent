// 这里统一导出工具框架的注册、执行、结果展示和基础类型接口。
export type {
  ReadFileEntry,
  ReadFileState,
  IFileStateStoreEntry,
  IFileStateStore,
  RunOptions,
  RunResult,
  ICommandRunner,
  SubagentSpawnOpts,
  ISubagentSpawner,
  IMcpClientBridge,
  ISkillRunner,
  SkillRunResult,
  ToolCapabilityRestriction,
  ToolCapabilitySnapshot,
  IToolCapabilityScope,
  ToolExecutionContext,
  ToolExecutionRecord,
  ToolExecutionStatus,
  ToolDescriptor,
  ToolManifestEntry,
  ToolManifestSnapshot,
  ToolOrigin,
  ToolInputValidationResult,
  ToolDef,
  BuiltTool,
} from './types.js';
export type { DeepReadonly, PreparedToolCall } from './prepared-call.js';
export { presentToolResult, splitToolResult } from './tool-result.js';
export type { SplitToolResult } from './tool-result.js';

export { buildTool, DEFAULT_MAX_RESULT_BYTES } from './build-tool.js';
export {
  createToolManifestSnapshot,
  createToolManifestSnapshotFromEntries,
} from './toolManifest.js';
export {
  ToolRegistry,
  ToolRegistryError,
  ToolInputError,
  ToolRegistrationConflictError,
} from './registry.js';
export type { McpToolOwner, McpToolRegistration } from './registry.js';
export { spawnProcess } from './process-spawn.js';
export {
  DEFAULT_AGGREGATE_RESULT_BYTES,
  DEFAULT_RESULT_PREVIEW_BYTES,
  ToolResultStore,
  generatePreview,
  DEFAULT_CLEANER_CONFIG,
  ToolResultCleaner,
} from './results/index.js';
export type {
  AggregateResultCandidate,
  AggregateResultContents,
  NormalizeResult,
  CleanerConfig,
} from './results/index.js';
