// 模式与 turn
export { EMA_MODES, isEmaMode } from "./modes.js";
export type { EmaMode, ModeSelectionState } from "./modes.js";
export type {
  StartTurnRequest,
  StartTurnResponse,
  TurnInputBlock,
  TurnRecord,
  TurnStatus,
  StepStatus,
  StepView,
  CreateTurnInput,
  UpdateTurnInput,
  ListTurnsOptions,
  TurnPage,
  TurnRepository,
  UsageView,
} from "./turns.js";

// 会话与消息
export type {
  MessageRole,
  MessageContentBlock,
  ChatMessage,
  ToolCall,
  ToolResult,
  SessionState,
  CreateSessionInput,
  SessionSummary,
  SessionTitleStatus,
  ListMessagesOptions,
  MessagePage,
  ToolCallMeta,
  ToolConfirmPayload,
  SessionRepository,
  ShouldGenerateTitleRequest,
  GenerateSessionTitleRequest,
  SessionTitleResult,
} from "./session.js";

export type {
  ContextSource,
  ContextBlock,
  RecallRequest,
  RecallResult,
  RecallMeta,
  RecallSourceStat,
  RollingSummary,
  AgentWorkingMemory,
  ToolTrace,
  ReflectionMemo,
  ExtractedFact,
  AgentSessionIdentity,
  WorldState,
  NarrativeBridgeQuery,
  NarrativeBridgeResult,
  UserProfile,
  VisionMemoryBlock,
  MemoryWriteRequest,
  GraphNodePlaceholder,
  GraphEdgePlaceholder,
} from "./memory.js";

// 模型与 LLM
export type { 
  ProviderKind,
  ModelCapabilities,
  ModelRole,
  ProviderHealthView,
  ProviderDescriptor,
  ModelDescriptor, 
  ToolSpec, 
  ChatCompletionMessageRole,
  ChatCompletionMessage,
  ChatCompletionCachePolicy,
  ChatCompletionRequest, 
  ToolCallChunk, 
  ChatCompletionChunk 
} from "./model.js";

// 运行时输入
export type { RuntimeInputEnvelope, ContextBlockSource, RuntimeContextBlock } from "./runtime-input.js";

// 渲染协议与 Workspace 产物
export type { RenderBlock, EmotionName, ActState } from "./response-markup.js";
export type {
  ArtifactKind,
  ArtifactStatus,
  ArtifactSummary,
  FileDiffSummary,
  DiffSummary,
  ArtifactMeta,
} from "./artifacts.js";

// 元数据
export type { EmaTurnMetadata, PromptAssemblyMeta } from "./metadata.js";

// 事件
export type {
  ContextBudgetView,
  ContextSourceView,
  ToolCallView,
  ToolOutputView,
  PermissionRequestView,
  PermissionDecision,
  StageCue,
  StepEvent,
  EmaStreamEvent,
} from "./events.js";

// 错误
export { toInternalUiError } from "./errors.js";
export type { UiErrorCode, UiErrorSeverity, UiErrorView } from "./errors.js";
