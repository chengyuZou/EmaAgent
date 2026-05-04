/**
 * Model Binding 仓储 — model_bindings 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type {
  ModelBindingRecord,
  ModelRole,
  ModelId,
  ProviderId,
} from "@ema-agent/core-types"

export interface CreateModelBindingInput {
  id: string
  role: ModelRole
  providerId: ProviderId
  modelId: ModelId
  createdAt?: number
}

export interface UpdateModelBindingInput {
  id: string
  providerId?: ProviderId
  modelId?: ModelId
}

export interface ModelBindingRepository {
  upsert(input: CreateModelBindingInput): Promise<ModelBindingRecord>
  getByRole(role: ModelRole): Promise<ModelBindingRecord | null>
  getById(id: string): Promise<ModelBindingRecord | null>
  list(): Promise<ModelBindingRecord[]>
  update(input: UpdateModelBindingInput): Promise<void>
  deleteByRole(role: ModelRole): Promise<void>
}

interface ModelBindingRow {
  id: string
  role: string
  provider_id: string
  model_id: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: ModelBindingRow): ModelBindingRecord {
  return {
    id: row.id,
    role: row.role as ModelRole,
    providerId: row.provider_id as ProviderId,
    modelId: row.model_id as ModelId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createModelBindingRepository(db: Database): ModelBindingRepository {
  return {
    async upsert(input) {
      const now = input.createdAt ?? Date.now()
      // role 唯一：每个 role 只能绑定一个 model
      db.prepare(`
        INSERT INTO model_bindings (id, role, provider_id, model_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          provider_id = excluded.provider_id, model_id = excluded.model_id, updated_at = excluded.updated_at
      `).run(input.id, input.role, input.providerId, input.modelId, now, now)

      const row = db.prepare("SELECT * FROM model_bindings WHERE role = ?").get(input.role) as ModelBindingRow
      return rowToRecord(row)
    },

    async getByRole(role) {
      const row = db.prepare("SELECT * FROM model_bindings WHERE role = ?").get(role) as ModelBindingRow | undefined
      return row ? rowToRecord(row) : null
    },

    async getById(id) {
      const row = db.prepare("SELECT * FROM model_bindings WHERE id = ?").get(id) as ModelBindingRow | undefined
      return row ? rowToRecord(row) : null
    },

    async list() {
      const rows = db.prepare("SELECT * FROM model_bindings ORDER BY role ASC").all() as ModelBindingRow[]
      return rows.map(rowToRecord)
    },

    async update(input) {
      const sets: string[] = []
      const vals: unknown[] = []

      if (input.providerId !== undefined) { sets.push("provider_id = ?"); vals.push(input.providerId) }
      if (input.modelId !== undefined) { sets.push("model_id = ?"); vals.push(input.modelId) }

      if (sets.length === 0) return

      sets.push("updated_at = ?")
      vals.push(Date.now(), input.id)
      db.prepare(`UPDATE model_bindings SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
    },

    async deleteByRole(role) {
      db.prepare("DELETE FROM model_bindings WHERE role = ?").run(role)
    },
  }
}
