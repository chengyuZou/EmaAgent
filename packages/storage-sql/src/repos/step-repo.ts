/**
 * Step 仓储 — steps 表 CRUD（ReAct 步骤追踪）。
 */

import type { Database } from "better-sqlite3"
import type {
  StepRecord,
  StepStatus,
  ReActStepType,
  RequestId,
  SessionId,
  StepId,
  ToolCallId,
} from "@ema-agent/core-types"

export interface CreateStepInput {
  id: StepId
  requestId: RequestId
  sessionId: SessionId
  stepType: ReActStepType
  title: string
  status?: StepStatus
  detail?: string
  toolCallId?: ToolCallId
  toolName?: string
  artifactIds?: string[]
  startedAt?: number
}

export interface UpdateStepInput {
  stepId: StepId
  status?: StepStatus
  detail?: string
  artifactIds?: string[]
  endedAt?: number
}

export interface StepRepository {
  createStep(input: CreateStepInput): Promise<StepRecord>
  getStepById(stepId: StepId): Promise<StepRecord | null>
  updateStep(input: UpdateStepInput): Promise<void>
  listStepsByRequest(requestId: RequestId): Promise<StepRecord[]>
}

interface StepRow {
  id: string
  request_id: string
  session_id: string
  step_type: string
  title: string
  status: string
  detail: string | null
  tool_call_id: string | null
  tool_name: string | null
  artifact_ids: string | null
  started_at: number
  ended_at: number | null
}

function rowToStep(row: StepRow): StepRecord {
  return {
    id: row.id as StepId,
    requestId: row.request_id as RequestId,
    sessionId: row.session_id as SessionId,
    stepType: row.step_type as ReActStepType,
    title: row.title,
    status: row.status as StepStatus,
    detail: row.detail ?? undefined,
    toolCallId: (row.tool_call_id as ToolCallId) ?? undefined,
    toolName: row.tool_name ?? undefined,
    artifactIds: row.artifact_ids ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  }
}

export function createStepRepository(db: Database): StepRepository {
  return {
    async createStep(input) {
      const now = input.startedAt ?? Date.now()
      db.prepare(`
        INSERT INTO steps (id, request_id, session_id, step_type, title, status, detail, tool_call_id, tool_name, artifact_ids, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.requestId, input.sessionId, input.stepType, input.title,
        input.status ?? "pending", input.detail ?? null, input.toolCallId ?? null,
        input.toolName ?? null, input.artifactIds ? JSON.stringify(input.artifactIds) : null, now,
      )

      const row = db.prepare("SELECT * FROM steps WHERE id = ?").get(input.id) as StepRow
      return rowToStep(row)
    },

    async getStepById(stepId) {
      const row = db.prepare("SELECT * FROM steps WHERE id = ?").get(stepId) as StepRow | undefined
      return row ? rowToStep(row) : null
    },

    async updateStep(input) {
      const sets: string[] = []
      const vals: unknown[] = []

      if (input.status !== undefined) { sets.push("status = ?"); vals.push(input.status) }
      if (input.detail !== undefined) { sets.push("detail = ?"); vals.push(input.detail) }
      if (input.artifactIds !== undefined) { sets.push("artifact_ids = ?"); vals.push(JSON.stringify(input.artifactIds)) }
      if (input.endedAt !== undefined) { sets.push("ended_at = ?"); vals.push(input.endedAt) }

      if (sets.length === 0) return

      vals.push(input.stepId)
      db.prepare(`UPDATE steps SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
    },

    async listStepsByRequest(requestId) {
      const rows = db.prepare(
        "SELECT * FROM steps WHERE request_id = ? ORDER BY started_at ASC"
      ).all(requestId) as StepRow[]
      return rows.map(rowToStep)
    },
  }
}
