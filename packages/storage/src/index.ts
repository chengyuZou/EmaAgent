export { Database, DatabaseCapabilityError } from './database.js';
export { MigrationsRunner } from './migrations.js';

export { SessionsRepo, nextCursorFor } from './repos/sessions.js';
export { TurnsRepo } from './repos/turns.js';
export { MessagesRepo } from './repos/messages.js';
export { BranchesRepo } from './repos/branches.js';
export { CharacterCardsRepo } from './repos/character-cards.js';
export { SettingsRepo } from './repos/settings.js';
export { TelemetryRepo } from './repos/telemetry.js';
export { UsageRepo } from './repos/usage.js';
export { Live2DModelsRepo } from './repos/live2d-models.js';
export { ProvidersRepo } from './repos/providers.js';
export { ModelBindingsRepo } from './repos/model-bindings.js';
export { ArtifactRepo }    from './repos/artifact.js';
export { AttachmentRepo }  from './repos/attachment.js';
export type { AttachmentRow, AttachmentInsert } from './repos/attachment.js';
export { SessionStatsRepo, DataDirStatsRepo, SessionRestoreValidationError } from './repos/storage-stats.js';
export type {
  SessionStats, AudioEntryRow, ArtifactSummaryRow,
  MemoryStateRow,
  TurnRestoreRow, MessageRestoreRow, ArtifactRestoreRow,
  AudioRestoreRow, AttachmentRestoreRow, NotesRestoreData,
  SessionRestorePayload,
  DataDirStats,
} from './repos/storage-stats.js';
export { McpServersRepo }  from './repos/mcp-servers.js';
export type { McpServerRow } from './repos/mcp-servers.js';
export { SkillsRepo }      from './repos/skills.js';
export type { SkillRow }   from './repos/skills.js';
export { MarketSourcesRepo } from './repos/market-sources.js';
export type { MarketSourceRow } from './repos/market-sources.js';
export type { ProtectedDeleteResult } from './repos/mutation-results.js';

// ── Memory 子系统 ──────────────────────────────────────────────────────────────
export { MemoryNodesRepo }       from './repos/memory-nodes.js';
export { MemoryEdgesRepo }       from './repos/memory-edges.js';
export { MemoryLazyUpdatesRepo } from './repos/memory-lazy-updates.js';
export { MemoryItemsRepo }       from './repos/memory-items.js';
export { SessionNotesRepo }      from './repos/session-notes.js';
export { MemoryTasksRepo }   from './repos/memory-tasks.js';
export { PendingFragmentsRepo }       from './repos/pending-fragments.js';
export { MemorySessionStateRepo }     from './repos/memory-session-state.js';

export type { DatabaseOptions, SqliteDb } from './database.js';
export type { SessionRow, SessionRowEnriched, SessionSearchRow, SessionInsert, SessionsGrouped } from './repos/sessions.js';
export type { TurnRow, TurnInsert, TurnCompletion } from './repos/turns.js';
export type { MessageRow, MessageInsert } from './repos/messages.js';
export type { BranchRow, BranchInsert } from './repos/branches.js';
export type { CharacterCardRow, CharacterCardInsert } from './repos/character-cards.js';
export type { SettingRow } from './repos/settings.js';
export type { TelemetryEventRow } from './repos/telemetry.js';
export type { TurnUsageRow } from './repos/usage.js';
export type { Live2DModelRow } from './repos/live2d-models.js';
export type {
  ProviderConfigRow,
  ProviderConfigInsert,
  ProviderHealthRow,
  ProviderWithHealth,
  HealthStatus,
} from './repos/providers.js';
export type {
  BindingModule,
  ModelBindingRow,
  ModelBindingUpsert,
  ResolvedModelBinding,
} from './repos/model-bindings.js';

// ── Memory 子系统类型 ──────────────────────────────────────────────────────────
export type {
  MemoryNodeRow,
  MemoryNodeInsert,
  MemoryNodeType,
  MemoryNodeDescriptionUpdate,
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

// ── Agent task repo ───────────────────────────────────────────────────────────
export { AgentTasksRepo }        from './repos/agent-tasks.js';
export { AgentTaskMessagesRepo } from './repos/agent-task-messages.js';
export type { AgentTaskRow, AgentTaskInsert, AgentTaskStatus }           from './repos/agent-tasks.js';
export type { AgentTaskMessageRow, AgentTaskMessageInsert, AgentTaskMessageRole } from './repos/agent-task-messages.js';

// ── Knowledge-base repo ────────────────────────────────────────────────────────
export { DocumentAssetRepo, DocumentAssetCursorError } from './repos/document-asset.js';
export { DocumentChunkRepo }   from './repos/document-chunk.js';
export { DocumentPreviewRepo } from './repos/document-preview.js';
export { KbActivationsRepo }   from './repos/kb-activations.js';
export type { AssetUsage }     from './repos/kb-activations.js';
export { KbIngestTasksRepo }   from './repos/kb-ingest-tasks.js';
export type { KbIngestTask, KbIngestStatus } from './repos/kb-ingest-tasks.js';
export { KbRegistryRepo }      from './repos/kb-registry.js';
export type { KbRecord }       from './repos/kb-registry.js';
export type { DocumentAssetRow, DocumentAssetInsert, AssetPage } from './repos/document-asset.js';
export type { DocumentChunkRow, DocumentChunkInsert, ChunkSearchHit, ChunkSummary, ChunkPage }  from './repos/document-chunk.js';
export type { DocumentPreviewRow, DocumentPreviewUpsert } from './repos/document-preview.js';
export type { KbActivationRow }                           from './repos/kb-activations.js';
