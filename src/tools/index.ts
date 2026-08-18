// 统一导出工具框架的定义、注册、执行和结果边界。
export {
  contentHashOf,
} from './types.js';
export type {
  ReadFileEntry,
  ReadFileState,
} from './types.js';
export type {
  Tool,
  ToolOrigin,
  ToolInputValidationResult,
  ToolContextValidation,
  ToolProgressCallback,
} from './Tool/tool.js';
export { contextFail, contextOk } from './Tool/tool.js';
export type { ToolInvocation } from './Tool/toolInvocation.js';
export type {
  AskUserPort,
  Scratchpad,
  SubagentContextMode,
  SubagentRunResult,
  SubagentSpawnOptions,
  SubagentSpawnerFn,
  ToolUseContext,
  ToolVisionSelection,
} from './Tool/toolUseContext.js';
export type {
  AskUserQuestionSpec,
  AskUserRequiredEvent,
  PendingAskUserPrompt,
  ToolError,
  ToolStreamEvent,
  ToolExecutionEvent,
} from './events.js';
export type { ToolResult } from './results/toolResult.js';
export {
  StreamingToolExecutor,
} from './execution/streamingToolExecutor.js';
export type {
  StreamingToolExecutorEvent,
  StreamingToolExecutorOptions,
} from './execution/streamingToolExecutor.js';
export { buildTool, DEFAULT_MAX_RESULT_BYTES } from './Tool/buildTool.js';
export { assembleToolPool } from './assembly/assembleToolPool.js';
export { ToolPool } from './assembly/toolPool.js';
export { ToolRegistry } from './assembly/toolRegistry.js';
export {
  BackgroundProcessError,
  createBackgroundProcessAbortError,
  ToolDefinitionError,
  ToolExecutionStateConflictError,
  ToolInputError,
  ToolRegistrationConflictError,
  ToolRegistryError,
  ToolResultStoreError,
} from './errors.js';
export type { BackgroundProcessErrorCode } from './errors.js';
export {
  DEFAULT_AGGREGATE_RESULT_BYTES,
  DEFAULT_RESULT_PREVIEW_BYTES,
  ToolResultStore,
  generatePreview,
  DEFAULT_CLEANER_SETTINGS,
  ToolResultCleaner,
} from './results/index.js';
export { ToolExecutionState } from './execution/toolExecutionState.js';
export type {
  ToolExecutionStateStore,
  ToolExecutionPrepareRecord,
  ToolExecutionRecord,
  ToolExecutionStatus,
} from './execution/toolExecutionState.js';
export type {
  AggregateResultCandidate,
  AggregateResultContents,
  NormalizeResult,
  ToolResultCleanerSettings,
} from './results/index.js';
export * from './background/index.js';
export {
  BuiltinTools,
  type BuiltinToolIdentity,
} from './Tool/BuiltinToolIdentity.js';
export {
  ASK_USER_TOOL_ID,
  DEFAULT_TOOL_SETTINGS,
  disabledToolsSetting,
  readToolSettings,
} from './settings.js';
export type { ToolSettings } from './settings.js';
export { describeToolForCatalog } from './catalog.js';
export type { ToolCatalogItem } from './catalog.js';
