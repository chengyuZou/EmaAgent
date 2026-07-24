// 统一导出工具框架的注册、执行、结果展示和基础类型接口。
export type {
  ReadFileEntry,
  ReadFileState,
  FileStateStoreEntry,
  FileStateStore,
  SubagentRunResult,
  SubagentSpawnOpts,
  SubagentContextMode,
  SubagentSpawnerPort,
  SkillRunnerPort,
  SkillRunResult,
  ToolCapabilityRestriction,
  ToolCapabilitySnapshot,
  ToolCapabilityScope,
  KnowledgeSearchPort,
  ToolInvocationContext,
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
  FileChangePresentation,
  PendingAskUserPrompt,
  ToolError,
  ToolFailurePhase,
  ToolPresentation,
  ToolStreamEvent,
  ToolExecutionEvent,
} from './events.js';
export { SessionFileStateStore } from './sessionFileStateStore.js';
export type { SessionFileStateEntry } from './sessionFileStateStore.js';
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
  ToolExecutionJournalConflictError,
} from './journal/toolExecutionJournal.js';
export type {
  ToolExecutionJournalPort,
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
