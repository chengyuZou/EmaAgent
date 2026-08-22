// 统一导出 Storage 数据库、迁移和各业务 Repo。
export { Database, DatabaseCapabilityError } from './database/database.js';
export { MigrationsRunner } from './database/migrationsRunner.js';
export {
  SQLITE_ID_BATCH_HARD_LIMIT,
  SqliteVariableLimitError,
  createSqliteIdBatches,
  sqliteVariableLimit,
} from './database/sqlite-id-batches.js';
export type { SqliteIdBatchOptions } from './database/sqlite-id-batches.js';

export { SessionsRepo } from './repos/data/sessions.js';
export { ProjectsRepo, ProjectFolderError } from './repos/data/projects.js';
export type { ProjectRow, ProjectFolderRow } from './repos/data/projects.js';
export { TurnsRepo } from './repos/data/turns.js';
export type {
  TurnIdPage,
  TurnIdPageCursor,
  TurnIndexRow,
  TurnPage,
  TurnWindow,
} from './repos/data/turns.js';
export { MessagesRepo } from './repos/data/messages.js';
export { CharacterRepo } from './repos/profile/character.js';
export { CharacterLive2dModelRepo } from './repos/profile/characterLive2dModel.js';
export { CharacterIllustrationRepo } from './repos/profile/characterIllustration.js';
export { CharacterVoiceSampleRepo } from './repos/profile/characterVoiceSample.js';
export { CharacterPromptBlockRepo } from './repos/profile/characterPromptBlock.js';
export { SettingsRepo } from './repos/profile/settings.js';
export { UsageRecordsRepo } from './repos/data/usage-records.js';
export { ProvidersRepo } from './repos/profile/providers.js';
export { ProviderModelsRepo } from './repos/profile/providerModels.js';
export { ModelBindingsRepo } from './repos/profile/modelBindings.js';
export { AttachmentRepo }  from './repos/data/attachments.js';
export type { AttachmentRow, AttachmentInsertRow, AttachmentRowKind } from './repos/data/attachments.js';
export { AttachmentVisionDescriptionsRepo } from './repos/data/attachmentVisionDescriptions.js';
export type {
  AttachmentVisionDescriptionKey,
  AttachmentVisionDescriptionRow,
} from './repos/data/attachmentVisionDescriptions.js';
export { SessionStatsRepo, DataDirStatsRepo } from './repos/data/storage-stats.js';
export {
  SessionBackupReader,
  SessionBackupRestorer,
  SessionBackupRestoreError,
} from './repos/data/sessionBackup.js';
export { SpeechOutputsRepo, SpeechSegmentsRepo } from './repos/data/speechOutputs.js';
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
  SpeechSegmentInsert,
  SpeechSegmentRow,
  SpeechSegmentUsage,
} from './repos/data/speechOutputs.js';
export { McpServersRepo }  from './repos/profile/mcp-servers.js';
export type { McpServerRow } from './repos/profile/mcp-servers.js';
export { McpRegistrySourcesRepo } from './repos/profile/mcp-registry-sources.js';
export type { McpRegistrySourceRow, McpRegistrySourceInsert } from './repos/profile/mcp-registry-sources.js';
export { SkillsRepo }      from './repos/profile/skills.js';
export type { SkillRow }   from './repos/profile/skills.js';
export { SkillSitesRepo }  from './repos/profile/skill-sites.js';
export type { SkillSiteRow, SkillSiteInsert } from './repos/profile/skill-sites.js';
export type { DatabaseOptions, SqliteDb } from './database/database.js';
export type { SessionRow, SessionRowEnriched, SessionSearchRow, SessionInsert, ExecutionProfileRow, NarrativePolicyRow } from './repos/data/sessions.js';
export type { TurnStatusRow, TurnTriggerTypeRow } from './repos/data/turns.js';
export type { TurnRow, TurnInsert, TurnCompletion } from './repos/data/turns.js';
export type { MessageRow, MessageInsert, MessageRole, MessageKind } from './repos/data/messages.js';
export { CharacterUpdateContractError } from './repos/profile/character.js';
export type {
  CharacterRow,
  CharacterInsert,
  CharacterUpdate,
  ProtectedDeleteResult
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
export type {
  CharacterPromptBlockRow,
  CharacterPromptBlockInsert,
  CharacterPromptBlockUpdate,
} from './repos/profile/characterPromptBlock.js';
export { SettingSerializationError } from './repos/profile/settings.js';
export type { SettingRow, SettingReadResult } from './repos/profile/settings.js';
export type { SettingWrite } from './repos/profile/settings.js';
export type { UsageRecordRow } from './repos/data/usage-records.js';
export type {
  MemoryExtractionResult,
  MemoryExtractionJobKind,
  MemoryJob,
  MemoryJobKind,
  MemoryJobPath,
  MemoryJobPathOperation,
  MemoryJobStatus,
  NewMemoryJob,
  NewMemoryJobPath,
  MemoryJobsRepo,
} from './repos/data/memory-jobs.js';
// ── AgentRun 存储 ─────────────────────────────────────────────────────────────
export { AgentRunsRepo } from './repos/data/agent-runs.js';
export {
  AgentRunMessagesRepo,
  AgentRunMessageSerializationError,
} from './repos/data/agent-run-messages.js';

export {
  TasksRepo,
  type TaskCreateRow,
  type TaskDeleteResult,
  type TaskDependencyRow,
  type TaskMutation,
  type TaskMutationFailure,
  type TaskMutationResult,
  type TaskRow,
  type TaskRowPatch,
  type TaskRowStatus,
} from './repos/data/tasks.js';
export type {
  AgentRunCompletion,
  AgentRunInsert,
  AgentRunContextModeRow,
  AgentRunRow,
  AgentRunStatus,
} from './repos/data/agent-runs.js';
export type {
  AgentRunMessageInsert,
  AgentRunMessageRole,
  AgentRunMessageRow,
} from './repos/data/agent-run-messages.js';
export { ToolExecutionsRepo } from './repos/data/tool-executions.js';
export { BackgroundProcessesRepo } from './repos/data/backgroundProcesses.js';
export type {
  BackgroundProcessInsert,
  BackgroundProcessRow,
  BackgroundProcessStatus,
  BackgroundProcessTerminal,
} from './repos/data/backgroundProcesses.js';

// ── Knowledge-base repo ────────────────────────────────────────────────────────
export { DocumentAssetRepo, DocumentAssetCursorError } from './repos/kb/document-asset.js';
export { DocumentChunkRepo }   from './repos/kb/document-chunk.js';
export {
  DocumentPreviewRepo,
  DocumentPreviewValidationError,
} from './repos/kb/document-preview.js';
export { KbIngestTasksRepo }   from './repos/kb/kb-ingest-tasks.js';
export type {
  KbIngestTask,
  KbIngestStatus,
} from './repos/kb/kb-ingest-tasks.js';
export { KbReembedTasksRepo }  from './repos/kb/kb-reembed-tasks.js';
export type {
  KbReembedTask,
  KbReembedStatus,
} from './repos/kb/kb-reembed-tasks.js';
export { KbRegistryRepo }      from './repos/profile/kb-registry.js';
export type { KbRecord }       from './repos/profile/kb-registry.js';
export type { DocumentAssetRow, DocumentAssetInsert, AssetPage } from './repos/kb/document-asset.js';
export type { DocumentChunkRow, DocumentChunkInsert, ChunkSearchHit, ChunkSummary, ChunkPage }  from './repos/kb/document-chunk.js';
export type {
  DocumentPreview,
  DocumentPreviewMime,
  DocumentPreviewRow,
  DocumentPreviewUpsert,
} from './repos/kb/document-preview.js';
