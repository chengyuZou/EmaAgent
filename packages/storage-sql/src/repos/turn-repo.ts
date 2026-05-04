/**
 * Turn 仓储 — turns 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type {
  TurnRecord,
  UsageView,
  EmaMode,
  TurnStatus,
  RequestId,
  SessionId,
  ModelId,
  ProviderId,
  UnixMs,
} from "@ema-agent/core-types"

export interface CreateTurnInput {
  requestId: RequestId
  sessionId: SessionId
  mode: EmaMode
  status?: TurnStatus
  modelId?: ModelId
  providerId?: ProviderId
  startedAt?: UnixMs
}

export interface UpdateTurnInput {
  requestId: RequestId
  status?: TurnStatus
  modelId?: ModelId
  providerId?: ProviderId
  endedAt?: UnixMs
  usage?: UsageView
  errorCode?: string
  errorMessage?: string
}

export interface ListTurnsOptions {
  limit?: number
  beforeStartedAt?: UnixMs
  beforeRequestId?: RequestId
}

export interface TurnPage {
  items: TurnRecord[]
  hasMore: boolean
  nextBeforeStartedAt?: UnixMs
  nextBeforeRequestId?: RequestId
}

export interface TurnRepository {
  createTurn(input: CreateTurnInput): Promise<TurnRecord>
  getTurnById(requestId: RequestId): Promise<TurnRecord | null>
  updateTurn(input: UpdateTurnInput): Promise<void>
  listTurnsBySession(sessionId: SessionId, options?: ListTurnsOptions): Promise<TurnPage>
}

interface TurnRow {
  request_id: string
  session_id: string
  mode: string
  status: string
  model_id: string | null
  provider_id: string | null
  started_at: number
  ended_at: number | null
  usage_json: string | null
  error_code: string | null
  error_message: string | null
}

function rowToTurn(row: TurnRow): TurnRecord {
  return {
    requestId: row.request_id as RequestId,
    sessionId: row.session_id as SessionId,
    mode: row.mode as EmaMode,
    status: row.status as TurnStatus,
    modelId: (row.model_id as ModelId) ?? undefined,
    providerId: (row.provider_id as ProviderId) ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    usage: row.usage_json ? JSON.parse(row.usage_json) as UsageView : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  }
}

export function createTurnRepository(db: Database): TurnRepository {
  return {
    async createTurn(input) {
      const startedAt = input.startedAt ?? Date.now()
      const status = input.status ?? "queued"

      db.prepare(`
        INSERT INTO turns (request_id, session_id, mode, status, model_id, provider_id, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.requestId, input.sessionId, input.mode, status, input.modelId ?? null, input.providerId ?? null, startedAt)

      return (await this.getTurnById(input.requestId))!
    },

    async getTurnById(requestId) {
      const row = db.prepare("SELECT * FROM turns WHERE request_id = ?").get(requestId) as TurnRow | undefined
      return row ? rowToTurn(row) : null
    },

    async updateTurn(input) {
      const sets: string[] = []
      const vals: unknown[] = []

      if (input.status !== undefined) { sets.push("status = ?"); vals.push(input.status) }
      if (input.modelId !== undefined) { sets.push("model_id = ?"); vals.push(input.modelId) }
      if (input.providerId !== undefined) { sets.push("provider_id = ?"); vals.push(input.providerId) }
      if (input.endedAt !== undefined) { sets.push("ended_at = ?"); vals.push(input.endedAt) }
      if (input.usage !== undefined) { sets.push("usage_json = ?"); vals.push(JSON.stringify(input.usage)) }
      if (input.errorCode !== undefined) { sets.push("error_code = ?"); vals.push(input.errorCode) }
      if (input.errorMessage !== undefined) { sets.push("error_message = ?"); vals.push(input.errorMessage) }

      if (sets.length === 0) return

      vals.push(input.requestId)
      db.prepare(`UPDATE turns SET ${sets.join(", ")} WHERE request_id = ?`).run(...vals)
    },

    async listTurnsBySession(sessionId, options) {
      const limit = options?.limit ?? 20
      const params: unknown[] = [sessionId]

      let sql = "SELECT * FROM turns WHERE session_id = ?"

      if (options?.beforeStartedAt) {
        if (options.beforeRequestId) {
          sql += " AND (started_at < ? OR (started_at = ? AND request_id < ?))"
          params.push(options.beforeStartedAt, options.beforeStartedAt, options.beforeRequestId)
        } else {
          sql += " AND started_at < ?"
          params.push(options.beforeStartedAt)
        }
      }

      sql += " ORDER BY started_at DESC, request_id DESC LIMIT ?"
      params.push(limit + 1)

      const rows = db.prepare(sql).all(...params) as TurnRow[]
      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, limit) : rows
      const records = items.map(rowToTurn)

      return {
        items: records,
        hasMore,
        nextBeforeStartedAt: hasMore ? records[records.length - 1]!.startedAt : undefined,
        nextBeforeRequestId: hasMore ? records[records.length - 1]!.requestId : undefined,
      }
    },
  }
}
