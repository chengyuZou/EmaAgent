import { randomUUID } from "node:crypto"

import type { RequestId, SessionId } from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

export interface TelemetryRecordInput {
  traceId?: string
  requestId?: RequestId
  sessionId?: SessionId
  type: string
  level?: "debug" | "info" | "warn" | "error"
  payload?: Record<string, unknown>
}

/**
 * TelemetryRecorder 是结构化事件记录入口。
 *
 * 它不决定 UI 展示，也不负责日志滚动文件；这里只写 SQLite 的最近事件索引。
 */
export class TelemetryRecorder {
  constructor(private readonly storage: SqliteStorage) {}

  async record(input: TelemetryRecordInput): Promise<void> {
    await this.storage.telemetry.append({
      id: `tel_${randomUUID()}`,
      traceId: input.traceId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      type: input.type,
      level: input.level ?? "info",
      payload: input.payload ?? {},
      createdAt: Date.now(),
    })
  }
}
