/**
 * Provider Config 仓储 — provider_configs 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type {
  ProviderConfigRecord,
  ProviderCategory,
  ProviderKind,
  ProviderId,
  CredentialId,
} from "@ema-agent/core-types"

export interface CreateProviderConfigInput {
  id: ProviderId
  displayName: string
  category: ProviderCategory
  kind: ProviderKind
  enabled?: boolean
  configured?: boolean
  credentialId?: CredentialId
  baseUrl?: string
  apiKeyEncrypted?: string
  headersJson?: string
  createdAt?: number
}

export interface UpdateProviderConfigInput {
  providerId: ProviderId
  displayName?: string
  enabled?: boolean
  configured?: boolean
  credentialId?: CredentialId
  baseUrl?: string
  apiKeyEncrypted?: string
  headersJson?: string
}

export interface ProviderConfigRepository {
  create(input: CreateProviderConfigInput): Promise<ProviderConfigRecord>
  getById(providerId: ProviderId): Promise<ProviderConfigRecord | null>
  update(input: UpdateProviderConfigInput): Promise<void>
  list(): Promise<ProviderConfigRecord[]>
  listEnabled(): Promise<ProviderConfigRecord[]>
  delete(providerId: ProviderId): Promise<void>
}

interface ProviderConfigRow {
  id: string
  display_name: string
  category: string
  kind: string
  enabled: number
  configured: number
  credential_id: string | null
  base_url: string | null
  api_key_encrypted: string | null
  headers_json: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: ProviderConfigRow): ProviderConfigRecord {
  return {
    id: row.id as ProviderId,
    displayName: row.display_name,
    category: row.category as ProviderCategory,
    kind: row.kind as ProviderKind,
    enabled: Boolean(row.enabled),
    configured: Boolean(row.configured),
    credentialId: (row.credential_id as CredentialId) ?? undefined,
    baseUrl: row.base_url ?? undefined,
    apiKeyEncrypted: row.api_key_encrypted ?? undefined,
    headersJson: row.headers_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createProviderConfigRepository(db: Database): ProviderConfigRepository {
  return {
    async create(input) {
      const now = input.createdAt ?? Date.now()
      db.prepare(`
        INSERT INTO provider_configs (id, display_name, category, kind, enabled, configured, credential_id, base_url, api_key_encrypted, headers_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.displayName, input.category, input.kind,
        input.enabled !== false ? 1 : 0, input.configured !== false ? 1 : 0,
        input.credentialId ?? null, input.baseUrl ?? null,
        input.apiKeyEncrypted ?? null, input.headersJson ?? null, now, now,
      )

      const row = db.prepare("SELECT * FROM provider_configs WHERE id = ?").get(input.id) as ProviderConfigRow
      return rowToRecord(row)
    },

    async getById(providerId) {
      const row = db.prepare("SELECT * FROM provider_configs WHERE id = ?").get(providerId) as ProviderConfigRow | undefined
      return row ? rowToRecord(row) : null
    },

    async update(input) {
      const sets: string[] = []
      const vals: unknown[] = []

      if (input.displayName !== undefined) { sets.push("display_name = ?"); vals.push(input.displayName) }
      if (input.enabled !== undefined) { sets.push("enabled = ?"); vals.push(input.enabled ? 1 : 0) }
      if (input.configured !== undefined) { sets.push("configured = ?"); vals.push(input.configured ? 1 : 0) }
      if (input.credentialId !== undefined) { sets.push("credential_id = ?"); vals.push(input.credentialId) }
      if (input.baseUrl !== undefined) { sets.push("base_url = ?"); vals.push(input.baseUrl) }
      if (input.apiKeyEncrypted !== undefined) { sets.push("api_key_encrypted = ?"); vals.push(input.apiKeyEncrypted) }
      if (input.headersJson !== undefined) { sets.push("headers_json = ?"); vals.push(input.headersJson) }

      if (sets.length === 0) return

      sets.push("updated_at = ?")
      vals.push(Date.now(), input.providerId)
      db.prepare(`UPDATE provider_configs SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
    },

    async list() {
      const rows = db.prepare("SELECT * FROM provider_configs ORDER BY display_name ASC").all() as ProviderConfigRow[]
      return rows.map(rowToRecord)
    },

    async listEnabled() {
      const rows = db.prepare("SELECT * FROM provider_configs WHERE enabled = 1 ORDER BY display_name ASC").all() as ProviderConfigRow[]
      return rows.map(rowToRecord)
    },

    async delete(providerId) {
      db.prepare("DELETE FROM provider_configs WHERE id = ?").run(providerId)
    },
  }
}
