/**
 * EmaAgent SQLite 存储引擎 — 统一导出入口。
 *
 * ```
 * import { createSqliteStorage } from "@ema-agent/storage-sql"
 *
 * const storage = createSqliteStorage("/path/to/ema.db")
 * const session = await storage.sessions.getById(sid)
 * ```
 */

import { createDatabaseConnection } from "./connection.js"
import { createSessionRepository } from "./repos/session-repo.js"
import { createTurnRepository } from "./repos/turn-repo.js"
import { createMessageRepository } from "./repos/message-repo.js"
import { createArtifactRepository } from "./repos/artifact-repo.js"
import { createAttachmentRepository } from "./repos/attachment-repo.js"
import { createMemoryRepository } from "./repos/memory-fact-repo.js"
import { createTelemetryRepository } from "./repos/telemetry-repo.js"
import { createStepRepository } from "./repos/step-repo.js"
import { createProviderConfigRepository } from "./repos/provider-config-repo.js"
import { createModelBindingRepository } from "./repos/model-binding-repo.js"
import { createPermissionGrantRepository } from "./repos/permission-grant-repo.js"

export function createSqliteStorage(dbPath: string) {
  const db = createDatabaseConnection(dbPath)

  return {
    sessions: createSessionRepository(db),
    turns: createTurnRepository(db),
    messages: createMessageRepository(db),
    artifacts: createArtifactRepository(db),
    attachments: createAttachmentRepository(db),
    memory: createMemoryRepository(db),
    telemetry: createTelemetryRepository(db),
    steps: createStepRepository(db),
    providerConfigs: createProviderConfigRepository(db),
    modelBindings: createModelBindingRepository(db),
    permissionGrants: createPermissionGrantRepository(db),

    close: () => {
      db.pragma("wal_checkpoint(TRUNCATE)")
      db.close()
    },
  }
}

export type SqliteStorage = ReturnType<typeof createSqliteStorage>

// 仓储接口（供类型引用）
export type { SessionRepository } from "./repos/session-repo.js"
export type { TurnRepository, CreateTurnInput, UpdateTurnInput, ListTurnsOptions, TurnPage } from "./repos/turn-repo.js"
export type { MessageRepository } from "./repos/message-repo.js"
export type { ArtifactRepository, CreateArtifactInput, UpdateArtifactInput } from "./repos/artifact-repo.js"
export type { AttachmentRepository, CreateAttachmentInput, UpsertAttachmentChunkInput } from "./repos/attachment-repo.js"
export type { MemoryRepository, MemoryFactRecord, MemoryFactKind, SessionSummaryRecord } from "./repos/memory-fact-repo.js"
export type { TelemetryRepository, TelemetryEventRecord } from "./repos/telemetry-repo.js"
export type { StepRepository, CreateStepInput, UpdateStepInput } from "./repos/step-repo.js"
export type { ProviderConfigRepository, CreateProviderConfigInput, UpdateProviderConfigInput } from "./repos/provider-config-repo.js"
export type { ModelBindingRepository, CreateModelBindingInput, UpdateModelBindingInput } from "./repos/model-binding-repo.js"
export type { PermissionGrantRepository, CreatePermissionGrantInput } from "./repos/permission-grant-repo.js"

// FTS5 辅助
export { createFtsIndexes, rebuildFtsIndexes, searchMemoryFactsFts, searchAttachmentChunksFts, escapeLike } from "./fts.js"
