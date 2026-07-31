// 统一导出 Storage 数据库、迁移和各业务 Repo。
export { Database, DatabaseCapabilityError } from './database.js';
export { MigrationsRunner } from './migrations.js';
export {
  SQLITE_ID_BATCH_HARD_LIMIT,
  SqliteVariableLimitError,
  createSqliteIdBatches,
  sqliteVariableLimit,
} from './sqlite-id-batches.js';
export type { SqliteIdBatchOptions } from './sqlite-id-batches.js';

export { SessionsRepo, nextCursorFor } from './repos/sessions.js';
export { TurnsRepo } from './repos/turns.js';
export type {
  TurnIdPage,
  TurnIdPageCursor,
  TurnIndexRow,
  TurnPage,
  TurnWindow,
} from './repos/turns.js';
export { MessagesRepo } from './repos/messages.js';
export { CharacterCardsRepo } from './repos/character-cards.js';
export { CharacterLive2dVariantsRepo } from './repos/characterLive2dVariants.js';
export { CharacterPortraitsRepo } from './repos/characterPortraits.js';
export { CharacterVoiceReferencesRepo } from './repos/characterVoiceReferences.js';
export { SettingsRepo } from './repos/settings.js';
export { UsageRecordsRepo } from './repos/usage-records.js';
export { ProvidersRepo } from './repos/providers.js';
export { ModelBindingsRepo } from './repos/model-bindings.js';
export { AttachmentRepo }  from './repos/attachment.js';
export type { AttachmentRow, AttachmentInsert } from './repos/attachment.js';
export { AttachmentDerivationsRepo } from './repos/attachmentDerivations.js';
export type {
  AttachmentVisionDerivationIdentity,
  AttachmentVisionDerivationInsert,
  AttachmentVisionDerivationRow,
  AttachmentVisionTask,
  CachedAttachmentImageInsert,
  CachedAttachmentImageRow,
} from './repos/attachmentDerivations.js';
export { SessionStatsRepo, DataDirStatsRepo, SessionRestoreValidationError } from './repos/storage-stats.js';
export { SessionBackupReader } from './repos/sessionBackup.js';
export {
  SessionBackupRestorer,
  SessionBackupRestoreError,
} from './repos/sessionBackupRestore.js';
export type {
  SessionStats, AudioEntryRow,
  MemoryStateRow,
  TurnRestoreRow, MessageRestoreRow,
  AudioRestoreRow, AttachmentRestoreRow, NotesRestoreData,
  SessionRestorePayload,
  TaskRestoreRow,
  AgentRunMessageRestoreRow,
  DataDirStats,
} from './repos/storage-stats.js';
export type {
  SessionBackupSnapshot,
  SessionBackupToolExecutionRow,
} from './repos/sessionBackup.js';
export type { SessionBackupRestoreInput } from './repos/sessionBackupRestore.js';
export { McpServersRepo }  from './repos/mcp-servers.js';
export type { McpServerRow } from './repos/mcp-servers.js';
export { SkillsRepo }      from './repos/skills.js';
export type { SkillRow }   from './repos/skills.js';
export { MarketSourcesRepo } from './repos/market-sources.js';
export type { MarketSourceRow } from './repos/market-sources.js';
export { PermissionRulesRepo } from './repos/permissionRules.js';
export type { PermissionRuleRow } from './repos/permissionRules.js';
export type { ProtectedDeleteResult } from './repos/mutation-results.js';

// ── Memory 子系统 ──────────────────────────────────────────────────────────────
export { MemoryNodesRepo }       from './repos/memory-nodes.js';
export type { MemoryEmbeddingPageCursor } from './repos/memory-embedding-page.js';
export { MemoryEdgesRepo }       from './repos/memory-edges.js';
export { MemoryLazyUpdatesRepo } from './repos/memory-lazy-updates.js';
export { MemoryItemsRepo }       from './repos/memory-items.js';
export { SessionNotesRepo }      from './repos/session-notes.js';
export { MemoryTasksRepo }   from './repos/memory-tasks.js';
export { PendingFragmentsRepo }       from './repos/pending-fragments.js';
export { MemorySessionStateRepo }     from './repos/memory-session-state.js';
export { MemoryExtractionRunsRepo }   from './repos/memory-extraction-runs.js';
export { MemoryNodeSourcesRepo }      from './repos/memory-node-sources.js';
export { MemoryStorageRepo }          from './repos/memoryStorage.js';

export type { DatabaseOptions, SqliteDb } from './database.js';
export type { SessionRow, SessionRowEnriched, SessionSearchRow, SessionInsert, SessionsGrouped } from './repos/sessions.js';
export type { TurnRow, TurnInsert, TurnCompletion } from './repos/turns.js';
export type { MessageRow, MessageInsert, MessageRole, MessageKind } from './repos/messages.js';
export { CharacterCardUpdateContractError } from './repos/character-cards.js';
export type {
  CharacterCardRow,
  CharacterCardInsert,
  CharacterCardUpdate,
} from './repos/character-cards.js';
export type {
  CharacterLive2dFormat,
  CharacterLive2dVariantInsert,
  CharacterLive2dVariantRow,
  CharacterLive2dVariantUpdate,
} from './repos/characterLive2dVariants.js';
export type {
  CharacterPortraitInsert,
  CharacterPortraitMime,
  CharacterPortraitRow,
  CharacterPortraitUpdate,
} from './repos/characterPortraits.js';
export type {
  CharacterVoiceReferenceInsert,
  CharacterVoiceReferenceRow,
  CharacterVoiceReferenceUpdate,
} from './repos/characterVoiceReferences.js';
export { SettingSerializationError } from './repos/settings.js';
export type { SettingRow, SettingReadResult } from './repos/settings.js';
export type { SettingWrite } from './repos/settings.js';
export type { UsageRecordRow } from './repos/usage-records.js';
export type {
  ProviderConfigRow,
  ProviderConfigInsert,
  ProviderCapabilityConfigRow,
  ProviderCapabilityConfigInput,
  ProviderHealthRow,
  ProviderWithHealth,
  HealthStatus,
} from './repos/providers.js';
// ── Memory 子系统类型 ──────────────────────────────────────────────────────────
export type {
  MemoryNodeRow,
  MemoryNodeInsert,
  MemoryNodeType,
  MemoryNodeDescriptionUpdate,
  MemoryNodeConsolidationUpdate,
  MemoryNodeEmbeddingUpdate,
} from './repos/memory-nodes.js';
export type {
  MemoryEdgeRow,
  MemoryEdgeUpsert,
} from './repos/memory-edges.js';
export type {
  MemoryNodeLazyUpdateRow,
  MemoryNodeLazyUpdateInsert,
} from './repos/memory-lazy-updates.js';
export type {
  MemoryItemRow,
  MemoryItemInsert,
  MemoryItemKind,
  MemoryItemEmbeddingUpdate,
} from './repos/memory-items.js';
export type {
  SessionNoteRow,
  SessionNoteUpsert,
} from './repos/session-notes.js';
export type {
  MemoryTaskRow,
  MemoryTaskEnqueue,
  MemoryTaskKind,
  MemoryTaskStatus,
} from './repos/memory-tasks.js';
export type {
  PendingFragmentRow,
  PendingFragmentInsert,
} from './repos/pending-fragments.js';
export type {
  MemoryExtractionRunRow,
  MemoryExtractionRunInsert,
} from './repos/memory-extraction-runs.js';
export type { MemoryNodeSourceRow } from './repos/memory-node-sources.js';
export type { MemoryStorageFootprint } from './repos/memoryStorage.js';

// ── 各 Provider 模型池 ─────────────────────────────────────────────────────────
export { ProviderLlmModelsRepo } from './repos/provider-llm-models.js';
export type { ProviderLlmModelRow, ProviderLlmModelInsert, ContextSource } from './repos/provider-llm-models.js';
export { ProviderEmbedModelsRepo } from './repos/provider-embed-models.js';
export type { ProviderEmbedModelRow, ProviderEmbedModelInsert, DimSource } from './repos/provider-embed-models.js';
export { ProviderRerankModelsRepo } from './repos/provider-rerank-models.js';
export type { ProviderRerankModelRow, ProviderRerankModelInsert } from './repos/provider-rerank-models.js';
export { ProviderTtsModelsRepo } from './repos/provider-tts-models.js';
export type { ProviderTtsModelRow, ProviderTtsModelInsert } from './repos/provider-tts-models.js';
export { ProviderSttModelsRepo } from './repos/provider-stt-models.js';
export type { ProviderSttModelRow, ProviderSttModelInsert } from './repos/provider-stt-models.js';
export { ProviderVisionModelsRepo } from './repos/provider-vision-models.js';
export type { ProviderVisionModelRow, ProviderVisionModelInsert } from './repos/provider-vision-models.js';

// ── AgentRun 存储 ─────────────────────────────────────────────────────────────
export { AgentRunsRepo } from './repos/agent-runs.js';
export {
  AgentRunMessagesRepo,
  AgentRunMessageSerializationError,
} from './repos/agent-run-messages.js';

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
} from './repos/tasks.js';
export type {
  AgentRunCompletion,
  AgentRunInsert,
  AgentRunKind,
  AgentRunRow,
  AgentRunStatus,
} from './repos/agent-runs.js';
export type {
  AgentRunMessageInsert,
  AgentRunMessageRole,
  AgentRunMessageRow,
} from './repos/agent-run-messages.js';
export { ToolExecutionsRepo } from './repos/tool-executions.js';
export { BackgroundProcessesRepo } from './repos/backgroundProcesses.js';
export type {
  BackgroundProcessInsert,
  BackgroundProcessRow,
  BackgroundProcessStatus,
  BackgroundProcessTerminal,
} from './repos/backgroundProcesses.js';

// ── Knowledge-base repo ────────────────────────────────────────────────────────
export { DocumentAssetRepo, DocumentAssetCursorError } from './repos/document-asset.js';
export { DocumentChunkRepo }   from './repos/document-chunk.js';
export {
  DocumentPreviewRepo,
  DocumentPreviewValidationError,
} from './repos/document-preview.js';
export { KbActivationsRepo }   from './repos/kb-activations.js';
export type { AssetUsage }     from './repos/kb-activations.js';
export { KbIngestTasksRepo }   from './repos/kb-ingest-tasks.js';
export type {
  KbIngestTask,
  KbIngestStatus,
  KbIngestFailureShard,
  KbIngestFailureStage,
} from './repos/kb-ingest-tasks.js';
export { KbReembedTasksRepo }  from './repos/kb-reembed-tasks.js';
export type {
  KbReembedTask,
  KbReembedStatus,
  KbReembedFailureShard,
  KbReembedFailureStage,
} from './repos/kb-reembed-tasks.js';
export { KbRegistryRepo }      from './repos/kb-registry.js';
export type { KbRecord }       from './repos/kb-registry.js';
export type { DocumentAssetRow, DocumentAssetInsert, AssetPage } from './repos/document-asset.js';
export type { DocumentChunkRow, DocumentChunkInsert, ChunkSearchHit, ChunkSummary, ChunkPage }  from './repos/document-chunk.js';
export type {
  DocumentPreview,
  DocumentPreviewMime,
  DocumentPreviewRow,
  DocumentPreviewUpsert,
} from './repos/document-preview.js';
export type { KbActivationRow }                           from './repos/kb-activations.js';
