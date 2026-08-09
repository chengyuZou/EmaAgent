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

export { SessionsRepo, nextCursorFor } from './repos/data/sessions.js';
export { TurnsRepo } from './repos/data/turns.js';
export type {
  TurnIdPage,
  TurnIdPageCursor,
  TurnIndexRow,
  TurnPage,
  TurnWindow,
} from './repos/data/turns.js';
export { MessagesRepo } from './repos/data/messages.js';
export { CharacterCardsRepo } from './repos/profile/character-cards.js';
export { CharacterLive2dVariantsRepo } from './repos/profile/characterLive2dVariants.js';
export { CharacterPortraitsRepo } from './repos/profile/characterPortraits.js';
export { CharacterVoiceReferencesRepo } from './repos/profile/characterVoiceReferences.js';
export { SettingsRepo } from './repos/profile/settings.js';
export { UsageRecordsRepo } from './repos/data/usage-records.js';
export { ProvidersRepo } from './repos/profile/providers.js';
export { ProviderModelsRepo } from './repos/profile/providerModels.js';
export { ModelBindingsRepo } from './repos/profile/modelBindings.js';
export { AttachmentRepo }  from './repos/data/attachment.js';
export type { AttachmentRow, AttachmentInsert } from './repos/data/attachment.js';
export { AttachmentDerivationsRepo } from './repos/data/attachmentDerivations.js';
export type {
  AttachmentVisionDerivationIdentity,
  AttachmentVisionDerivationInsert,
  AttachmentVisionDerivationRow,
  AttachmentVisionTask,
  CachedAttachmentImageInsert,
  CachedAttachmentImageRow,
} from './repos/data/attachmentDerivations.js';
export { SessionStatsRepo, DataDirStatsRepo, SessionRestoreValidationError } from './repos/data/storage-stats.js';
export { SessionBackupReader } from './repos/data/sessionBackup.js';
export {
  SessionBackupRestorer,
  SessionBackupRestoreError,
} from './repos/data/sessionBackupRestore.js';
export type {
  SessionStats, AudioEntryRow,
  MemoryStateRow,
  TurnRestoreRow, MessageRestoreRow,
  AudioRestoreRow, AttachmentRestoreRow, NotesRestoreData,
  SessionRestorePayload,
  TaskRestoreRow,
  AgentRunMessageRestoreRow,
  DataDirStats,
} from './repos/data/storage-stats.js';
export type {
  SessionBackupSnapshot,
  SessionBackupToolExecutionRow,
} from './repos/data/sessionBackup.js';
export type { SessionBackupRestoreInput } from './repos/data/sessionBackupRestore.js';
export { McpServersRepo }  from './repos/profile/mcp-servers.js';
export type { McpServerRow } from './repos/profile/mcp-servers.js';
export { McpRegistrySourcesRepo } from './repos/profile/mcp-registry-sources.js';
export type { McpRegistrySourceRow, McpRegistrySourceInsert } from './repos/profile/mcp-registry-sources.js';
export { SkillsRepo }      from './repos/profile/skills.js';
export type { SkillRow }   from './repos/profile/skills.js';
export { SkillSitesRepo }  from './repos/profile/skill-sites.js';
export type { SkillSiteRow, SkillSiteInsert } from './repos/profile/skill-sites.js';
export { PermissionRulesRepo } from './repos/profile/permissionRules.js';
export type { PermissionRuleRow } from './repos/profile/permissionRules.js';
export type { ProtectedDeleteResult } from './repos/profile/mutation-results.js';

// ── Memory 子系统 ──────────────────────────────────────────────────────────────
export { MemoryNodesRepo }       from './repos/profile/memory-nodes.js';
export type { MemoryEmbeddingPageCursor } from './repos/profile/memory-embedding-page.js';
export { MemoryEdgesRepo }       from './repos/profile/memory-edges.js';
export { MemoryLazyUpdatesRepo } from './repos/profile/memory-lazy-updates.js';
export { MemoryItemsRepo }       from './repos/profile/memory-items.js';
export { SessionNotesRepo }      from './repos/data/session-notes.js';
export { MemoryTasksRepo }   from './repos/data/memory-tasks.js';
export { PendingFragmentsRepo }       from './repos/data/pending-fragments.js';
export { MemorySessionStateRepo }     from './repos/data/memory-session-state.js';
export { MemoryExtractionRunsRepo }   from './repos/profile/memory-extraction-runs.js';
export { MemoryNodeSourcesRepo }      from './repos/profile/memory-node-sources.js';
export { MemoryStorageRepo }          from './repos/profile/memoryStorage.js';

export type { DatabaseOptions, SqliteDb } from './database/database.js';
export type { SessionRow, SessionRowEnriched, SessionSearchRow, SessionInsert, SessionsGrouped } from './repos/data/sessions.js';
export type { TurnRow, TurnInsert, TurnCompletion } from './repos/data/turns.js';
export type { MessageRow, MessageInsert, MessageRole, MessageKind } from './repos/data/messages.js';
export { CharacterCardUpdateContractError } from './repos/profile/character-cards.js';
export type {
  CharacterCardRow,
  CharacterCardInsert,
  CharacterCardUpdate,
} from './repos/profile/character-cards.js';
export type {
  CharacterLive2dFormat,
  CharacterLive2dVariantInsert,
  CharacterLive2dVariantRow,
  CharacterLive2dVariantUpdate,
} from './repos/profile/characterLive2dVariants.js';
export type {
  CharacterPortraitInsert,
  CharacterPortraitMime,
  CharacterPortraitRow,
  CharacterPortraitUpdate,
} from './repos/profile/characterPortraits.js';
export type {
  CharacterVoiceReferenceInsert,
  CharacterVoiceReferenceRow,
  CharacterVoiceReferenceUpdate,
} from './repos/profile/characterVoiceReferences.js';
export { SettingSerializationError } from './repos/profile/settings.js';
export type { SettingRow, SettingReadResult } from './repos/profile/settings.js';
export type { SettingWrite } from './repos/profile/settings.js';
export type { UsageRecordRow } from './repos/data/usage-records.js';
// ── Memory 子系统类型 ──────────────────────────────────────────────────────────
export type {
  MemoryNodeRow,
  MemoryNodeInsert,
  MemoryNodeType,
  MemoryNodeDescriptionUpdate,
  MemoryNodeConsolidationUpdate,
  MemoryNodeEmbeddingUpdate,
} from './repos/profile/memory-nodes.js';
export type {
  MemoryEdgeRow,
  MemoryEdgeUpsert,
} from './repos/profile/memory-edges.js';
export type {
  MemoryNodeLazyUpdateRow,
  MemoryNodeLazyUpdateInsert,
} from './repos/profile/memory-lazy-updates.js';
export type {
  MemoryItemRow,
  MemoryItemInsert,
  MemoryItemKind,
  MemoryItemEmbeddingUpdate,
} from './repos/profile/memory-items.js';
export type {
  SessionNoteRow,
  SessionNoteUpsert,
} from './repos/data/session-notes.js';
export type {
  MemoryTaskRow,
  MemoryTaskEnqueue,
  MemoryTaskKind,
  MemoryTaskStatus,
} from './repos/data/memory-tasks.js';
export type {
  PendingFragmentRow,
  PendingFragmentInsert,
} from './repos/data/pending-fragments.js';
export type {
  MemoryExtractionRunRow,
  MemoryExtractionRunInsert,
} from './repos/profile/memory-extraction-runs.js';
export type { MemoryNodeSourceRow } from './repos/profile/memory-node-sources.js';
export type { MemoryStorageFootprint } from './repos/profile/memoryStorage.js';

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
  AgentRunKind,
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
export { KbActivationsRepo }   from './repos/data/kb-activations.js';
export type { AssetUsage }     from './repos/data/kb-activations.js';
export { KbIngestTasksRepo }   from './repos/kb/kb-ingest-tasks.js';
export type {
  KbIngestTask,
  KbIngestStatus,
  KbIngestFailureShard,
  KbIngestFailureStage,
} from './repos/kb/kb-ingest-tasks.js';
export { KbReembedTasksRepo }  from './repos/kb/kb-reembed-tasks.js';
export type {
  KbReembedTask,
  KbReembedStatus,
  KbReembedFailureShard,
  KbReembedFailureStage,
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
export type { KbActivationRow }                           from './repos/data/kb-activations.js';
