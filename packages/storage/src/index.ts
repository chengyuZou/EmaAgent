export { Database } from './database.js';
export { MigrationsRunner } from './migrations.js';

export { SessionsRepo, nextCursorFor } from './repos/sessions.js';
export { TurnsRepo } from './repos/turns.js';
export { MessagesRepo } from './repos/messages.js';
export { CharacterCardsRepo } from './repos/character-cards.js';
export { SettingsRepo } from './repos/settings.js';
export { TelemetryRepo } from './repos/telemetry.js';
export { UsageRepo } from './repos/usage.js';
export { Live2DModelsRepo } from './repos/live2d-models.js';
export { ProvidersRepo } from './repos/providers.js';
export { ModelBindingsRepo } from './repos/model-bindings.js';
export { ArtifactRepo }    from './repos/artifact.js';
export { McpServersRepo }  from './repos/mcp-servers.js';
export type { McpServerRow } from './repos/mcp-servers.js';
export { SkillsRepo }      from './repos/skills.js';
export type { SkillRow }   from './repos/skills.js';

// ── Memory subsystem (migration 006) ──────────────────────────────────────────
export { MemoryNodesRepo }       from './repos/memory-nodes.js';
export { MemoryEdgesRepo }       from './repos/memory-edges.js';
export { MemoryLazyUpdatesRepo } from './repos/memory-lazy-updates.js';
export { MemoryItemsRepo }       from './repos/memory-items.js';
export { SessionNotesRepo }      from './repos/session-notes.js';
export { BackgroundTasksRepo }   from './repos/background-tasks.js';
export { PendingFragmentsRepo }  from './repos/pending-fragments.js';

export type { DatabaseOptions, SqliteDb } from './database.js';
export type { SessionRow, SessionInsert, SessionsGrouped } from './repos/sessions.js';
export type { TurnRow, TurnInsert, TurnCompletion } from './repos/turns.js';
export type { MessageRow, MessageInsert } from './repos/messages.js';
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

// ── Memory subsystem types ────────────────────────────────────────────────────
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
  BackgroundTaskRow,
  BackgroundTaskEnqueue,
  BackgroundTaskKind,
  BackgroundTaskStatus,
} from './repos/background-tasks.js';
export type {
  PendingFragmentRow,
  PendingFragmentInsert,
} from './repos/pending-fragments.js';
