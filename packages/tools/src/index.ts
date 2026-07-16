// 这里统一导出工具框架的注册、执行、结果展示和基础类型接口。
export type {
  ReadFileEntry,
  ReadFileState,
  IFileStateStoreEntry,
  IFileStateStore,
  RunOptions,
  RunResult,
  ICommandRunner,
  IArtifactStore,
  ArtifactUpsertArgs,
  SubagentSpawnOpts,
  ISubagentSpawner,
  IMcpClientBridge,
  ISkillRunner,
  ToolExecutionContext,
  ToolDescriptor,
  ToolDef,
  BuiltTool,
} from './types.js';
export type { DeepReadonly, PreparedToolCall } from './prepared-call.js';
export { presentToolResult, splitToolResult } from './tool-result.js';
export type { SplitToolResult } from './tool-result.js';

export { buildTool } from './build-tool.js';
export {
  ToolRegistry,
  ToolRegistryError,
  ToolInputError,
  ToolRegistrationConflictError,
} from './registry.js';
export type { McpToolOwner, McpToolRegistration } from './registry.js';
export { spawnProcess } from './process-spawn.js';
