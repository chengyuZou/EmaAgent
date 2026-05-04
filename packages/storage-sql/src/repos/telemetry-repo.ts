/**
 * Telemetry 仓储 — telemetry_events 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type { RequestId, SessionId } from "@ema-agent/core-types"

export interface TelemetryEventRecord {
  id: string
  traceId?: string
  requestId?: RequestId
  sessionId?: SessionId
  type: string
  level: "debug" | "info" | "warn" | "error"
  payload: Record<string, unknown>
  createdAt: number
}

export interface TelemetryRepository {
  append(event: TelemetryEventRecord): Promise<void>
  listRecent(limit?: number): Promise<TelemetryEventRecord[]>
  listByRequest(requestId: RequestId): Promise<TelemetryEventRecord[]>
}

interface TelemetryRow {
  id: string
  trace_id: string | null
  request_id: string | null
  session_id: string | null
  type: string
  level: string
  payload_json: string
  created_at: number
}

function rowToTelemetryEvent(row: TelemetryRow): TelemetryEventRecord {
  return {
    id: row.id,
    traceId: row.trace_id ?? undefined,
    requestId: (row.request_id as RequestId) ?? undefined,
    sessionId: (row.session_id as SessionId) ?? undefined,
    type: row.type,
    level: row.level as TelemetryEventRecord["level"],
    payload: JSON.parse(row.payload_json || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

export function createTelemetryRepository(db: Database): TelemetryRepository {
  return {
    async append(event) {
      db.prepare(`
        INSERT INTO telemetry_events (id, trace_id, request_id, session_id, type, level, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.id, event.traceId ?? null, event.requestId ?? null, event.sessionId ?? null, event.type, event.level, JSON.stringify(event.payload), event.createdAt)
    },

    async listRecent(limit = 50) {
      const rows = db.prepare(
        "SELECT * FROM telemetry_events ORDER BY created_at DESC LIMIT ?"
      ).all(limit) as TelemetryRow[]
      return rows.map(rowToTelemetryEvent)
    },

    async listByRequest(requestId) {
      const rows = db.prepare(
        "SELECT * FROM telemetry_events WHERE request_id = ? ORDER BY created_at ASC"
      ).all(requestId) as TelemetryRow[]
      return rows.map(rowToTelemetryEvent)
    },
  }
}
