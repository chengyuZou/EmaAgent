// 统一导出 Storage 数据库、迁移和各业务 Repo。
export { Database, DatabaseCapabilityError } from './database/database.js';
export { MigrationsRunner } from './database/migrationsRunner.js';
export { NarrativeChunksRepo } from './repos/narrative/chunks.js';
export type {
  NarrativeTimelineId,
  NarrativeChunkRow,
  NarrativeChunkVectorRow,
} from './repos/narrative/chunks.js';
export { NarrativeGraphRepo } from './repos/narrative/graph.js';
export type {
  NarrativeEntityRow,
  NarrativeEntityVectorRow,
  NarrativeRelationRow,
  NarrativeRelationVectorRow,
} from './repos/narrative/graph.js';
export { NarrativeKeywordCacheRepo } from './repos/narrative/keywordCache.js';
export type { NarrativeKeywords } from './repos/narrative/keywordCache.js';
export {
  SQLITE_ID_BATCH_HARD_LIMIT,
  SqliteVariableLimitError,
  createSqliteIdBatches,
  sqliteVariableLimit,
} from './database/sqlite-id-batches.js';
export type { SqliteIdBatchOptions } from './database/sqlite-id-batches.js';

export { SessionsRepo } from './repos/data/sessions.js';
export { GoalsRepo } from './repos/data/goals.js';
export type { GoalRow, GoalSummaryRow, GoalStatusRow, GoalReasonRow } from './repos/data/goals.js';
export { ProjectsRepo, ProjectFolderError } from './repos/data/projects.js';
export type { ProjectRow, ProjectFolderRow } from './repos/data/projects.js';
export { TurnsRepo } from './repos/data/turns.js';
export type {
  TurnIdPage,
  TurnIdPageCursor,
  TurnIndexRow,
  TurnPage,
} from './repos/data/turns.js';
export { MessagesRepo } from './repos/data/messages.js';
export type {
  MessagePageCursor,
  MessageRowPage,
  MessageRowWindow,
} from './repos/data/messages.js';
export { CharacterRepo } from './repos/profile/character.js';
export { CharacterLive2dModelRepo } from './repos/profile/characterLive2dModel.js';
export { CharacterIllustrationRepo } from './repos/profile/characterIllustration.js';
export { CharacterVoiceSampleRepo } from './repos/profile/characterVoiceSample.js';
export { SettingsRepo } from './repos/profile/settings.js';
export { UsageRecordsRepo } from './repos/data/usage-records.js';
export { ProvidersRepo } from './repos/profile/providers.js';
export type {
  ModelCapabilityRow,
  ProviderRow,
  ProviderCapabilityRow,
  ProviderProtocolRow,
  ProviderHealthRow,
  ProviderModelCountRow,
  ProviderSave,
} from './repos/profile/providers.js';
export { ProviderModelsRepo } from './repos/profile/providerModels.js';
export type { ProviderModelRow } from './repos/profile/providerModels.js';
export { ModelBindingsRepo } from './repos/profile/modelBindings.js';
export type { ModelBindingModuleRow, ModelBindingRow } from './repos/profile/modelBindings.js';
export { AttachmentImagesRepo } from './repos/data/attachmentImages.js';
export type { AttachmentImageRow, AttachmentImageInsertRow } from './repos/data/attachmentImages.js';
export { AttachmentPastedTextsRepo } from './repos/data/attachmentPastedTexts.js';
export type { AttachmentPastedTextRow, AttachmentPastedTextInsertRow } from './repos/data/attachmentPastedTexts.js';
export { AttachmentVisionDescriptionCachesRepo } from './repos/data/attachmentVisionDescriptionCaches.js';
export type { AttachmentVisionDescriptionCacheRow } from './repos/data/attachmentVisionDescriptionCaches.js';
export { SessionStatsRepo, DataDirStatsRepo } from './repos/data/storage-stats.js';
export {
  SessionBackupReader,
  SessionBackupRestorer,
  SessionBackupRestoreError,
} from './repos/data/sessionBackup.js';
export { SpeechOutputsRepo } from './repos/data/speechOutputs.js';
export type {
  SessionStats,
  DataDirStats,
} from './repos/data/storage-stats.js';
export type {
  SessionBackupRestoreRows,
  SessionBackupRows,
  SessionBackupTaskRow,
  SessionBackupToolExecutionRow,
} from './repos/data/sessionBackup.js';
export type {
  SpeechOutputInsert,
  SpeechOutputRow,
} from './repos/data/speechOutputs.js';
export { McpServersRepo }  from './repos/profile/mcp-servers.js';
export type { McpServerRow, McpServerSettingsRow } from './repos/profile/mcp-servers.js';
export { McpMarketEntriesRepo } from './repos/profile/mcp-market.js';
export type { McpMarketEntryRow, McpMarketFetchStateRow } from './repos/profile/mcp-market.js';
export { SkillsRepo }      from './repos/profile/skills.js';
export type { SkillRow }   from './repos/profile/skills.js';
export type { DatabaseOptions, SqliteDb } from './database/database.js';
export type {
  SessionRow,
  SessionRowEnriched,
  SessionSearchRow,
  SessionInsert,
  SessionModeRow,
  NarrativePolicyRow,
  PermissionModeRow,
} from './repos/data/sessions.js';
export type { TurnStatusRow, TurnTriggerTypeRow } from './repos/data/turns.js';
export type { TurnRow, TurnInsert, TurnCompletion } from './repos/data/turns.js';
export type { MessageRow, MessageInsert, MessageRole, MessageKind } from './repos/data/messages.js';
export type {
  CharacterRow,
  CharacterSummaryRow,
  CharacterInsert,
  CharacterUpdate,
  CharacterDeleteResult,
} from './repos/profile/character.js';
export type {
  CharacterLive2dModelInsert,
  CharacterLive2dModelRow,
  CharacterLive2dModelUpdate,
} from './repos/profile/characterLive2dModel.js';
export type {
  CharacterIllustrationInsert,
  CharacterIllustrationRow,
  CharacterIllustrationUpdate,
} from './repos/profile/characterIllustration.js';
export type {
  CharacterVoiceSampleInsert,
  CharacterVoiceSampleRow,
  CharacterVoiceSampleUpdate,
} from './repos/profile/characterVoiceSample.js';
export { SettingSerializationError } from './repos/profile/settings.js';
export type { SettingRow, SettingReadResult } from './repos/profile/settings.js';
export type { SettingWrite } from './repos/profile/settings.js';
export type {
  UsageRecordRow,
  UsageRecordListFilter,
  UsageRecordPage,
  UsageRecordPageCursor,
} from './repos/data/usage-records.js';
export { MemoryRepo } from './repos/data/memory.js';
export type {
  MemoryConsolidationJobKind,
  MemoryExtractionJobKind,
  MemoryExtractionReadiness,
  MemoryJob,
  MemoryJobKind,
  MemoryJobStatus,
  MemoryMaintenanceJobKind,
  RelationshipMemoryExtraction,
  WorkMemoryExtraction,
} from './repos/data/memory.js';
// ── Subagent 存储 ─────────────────────────────────────────────────────────────
export { SubagentsRepo } from './repos/data/subagents.js';
export { SubagentRunsRepo } from './repos/data/subagentRuns.js';
export {
  SubagentMessagesRepo,
} from './repos/data/subagent-messages.js';

export {
  TasksRepo,
  type TaskCreateRow,
  type TaskDeleteResult,
  type TaskMutation,
  type TaskMutationFailure,
  type TaskMutationResult,
  type TaskRow,
  type TaskRowPatch,
  type TaskRowStatus,
} from './repos/data/tasks.js';
export type {
  SubagentInsert,
  SubagentDetailsUpdate,
  SubagentPage,
  SubagentPageCursor,
  SubagentRow,
  SubagentStatusRow,
} from './repos/data/subagents.js';
export type {
  SubagentRunCompletion,
  SubagentRunConfiguration,
  SubagentRunInsert,
  SubagentRunPage,
  SubagentRunPageCursor,
  SubagentRunRow,
  SubagentContextModeRow,
} from './repos/data/subagentRuns.js';
export type {
  SubagentMessageInsert,
  SubagentMessagePage,
  SubagentMessageRow,
} from './repos/data/subagent-messages.js';
export { ToolExecutionsRepo } from './repos/data/tool-executions.js';
export { BackgroundProcessesRepo } from './repos/data/backgroundProcesses.js';
export type {
  BackgroundProcessInsert,
  BackgroundProcessRow,
  BackgroundProcessStatus,
  BackgroundProcessTerminal,
} from './repos/data/backgroundProcesses.js';
