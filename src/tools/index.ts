// 统一导出工具框架的注册、执行、结果展示和基础类型接口。
export type {
  ReadFileEntry,
  ReadFileState,
  ToolCapabilityRestriction,
  ToolCapabilitySnapshot,
  ToolCapabilityScope,
  ToolDescriptor,
  ToolManifestEntry,
  ToolManifestSnapshot,
  ToolOrigin,
  ToolInputValidationResult,
  ToolContextValidation,
  ToolDef,
  BuiltTool,
} from './types.js';
export type {
  AskUserQuestionSpec,
  AskUserRequiredEvent,
  PendingAskUserPrompt,
  ToolError,
  ToolFailurePhase,
  ToolStreamEvent,
  ToolExecutionEvent,
} from './events.js';
export {
  createBackgroundProcessPresentation,
  createCommandPresentation,
  createFileChangePresentation,
  createFileReadPresentation,
  createPdfReadPresentation,
  createSearchPresentation,
  isToolPresentation,
} from './presentation/index.js';
export type {
  BackgroundProcessPresentation,
  CommandPresentation,
  CreateCommandPresentationInput,
  CreateFileReadPresentationInput,
  CreateSearchPresentationInput,
  FileChangePresentation,
  FileReadPresentation,
  CreatePdfReadPresentationInput,
  PdfReadPresentation,
  SearchLimitReason,
  SearchPresentation,
  ToolPresentation,
} from './presentation/index.js';
export type { DeepReadonly, PreparedToolCall } from './prepared-call.js';
export type { ToolExecutionResult } from './execution/toolExecutionResult.js';
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
export { presentToolResult, splitToolResult } from './presentation/index.js';
export type { SplitToolResult } from './presentation/index.js';

export { buildTool, DEFAULT_MAX_RESULT_BYTES } from './build-tool.js';
export { assembleToolPool } from './assembleToolPool.js';
export {
  createToolManifestSnapshot,
  createToolManifestSnapshotFromEntries,
} from './toolManifest.js';
export { ToolRegistry } from './registry.js';
export type { McpToolOwner, McpToolRegistration } from './registry.js';
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
