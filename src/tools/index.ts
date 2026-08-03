// 统一导出工具框架的定义、注册、执行和结果边界。
export type {
  ReadFileEntry,
  ReadFileState,
  ToolCapabilityRestriction,
  ToolCapabilitySnapshot,
  ToolCapabilityScope,
  ToolManifestSnapshot,
  ExecutableToolManifestSnapshot,
} from './types.js';
export type {
  ToolDescriptor,
  ToolManifestEntry,
  ToolOrigin,
  ToolInputValidationResult,
  ToolContextValidation,
  ToolDef,
  BuiltTool,
} from './Tool/tool.js';
export type {
  AskUserPort,
  BuiltinToolContext,
  ScratchpadPort,
  SubagentContextMode,
  SubagentRunResult,
  SubagentSpawnOptions,
  SubagentSpawnerPort,
} from './Tool/toolUseContext.js';
export { contextFail, contextOk } from './Tool/toolUseContext.js';
export type {
  AskUserQuestionSpec,
  AskUserRequiredEvent,
  PendingAskUserPrompt,
  ToolError,
  ToolFailurePhase,
  ToolStreamEvent,
  ToolExecutionEvent,
} from './events.js';
export type { DeepReadonly, PreparedToolCall } from './preparation/preparedToolCall.js';
export type { ToolExecutionResult } from './execution/toolExecutionResult.js';
export { ToolExecution } from './execution/toolExecution.js';
export type {
  ToolExecutionCall,
  ToolExecutionCompletion,
  ToolExecutionEnvironment,
  ToolExecutionHostContext,
  ToolExecutionLiveEvent,
} from './execution/toolExecution.js';
export type {
  ToolLifecycleContext,
  ToolLifecycleObserver,
} from './execution/toolLifecycleObserver.js';
export {
  ToolExecutionRuntime,
} from './execution/toolExecutionRuntime.js';
export type {
  ToolExecutionRuntimeEvent,
  ToolExecutionRuntimeOptions,
} from './execution/toolExecutionRuntime.js';
export { buildTool, DEFAULT_MAX_RESULT_BYTES } from './Tool/buildTool.js';
export { assembleToolPool } from './assembly/assembleToolPool.js';
export {
  createToolManifestSnapshot,
  createToolManifestSnapshotFromEntries,
} from './assembly/toolManifest.js';
export { ToolRegistry } from './assembly/toolRegistry.js';
export type { McpToolOwner, McpToolRegistration } from './assembly/toolRegistry.js';
export {
  BackgroundProcessError,
  createBackgroundProcessAbortError,
  ToolDefinitionError,
  ToolExecutionJournalConflictError,
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
  DEFAULT_CLEANER_CONFIG,
  ToolResultCleaner,
} from './results/index.js';
export {
  ToolExecutionJournal,
} from './journal/toolExecutionJournal.js';
export type {
  ToolExecutionJournalPort,
  ToolExecutionJournalReader,
  ToolExecutionJournalStore,
  ToolExecutionPrepareRecord,
  ToolExecutionRecord,
  ToolExecutionStatus,
  ToolExecutionTerminalDetails,
} from './journal/toolExecutionJournal.js';
export type {
  AggregateResultCandidate,
  AggregateResultContents,
  NormalizeResult,
  CleanerConfig,
} from './results/index.js';
export * from './background/index.js';
