import type { FastifyInstance } from "fastify"

import { asId } from "@ema-agent/core-types"
import type { RequestId } from "@ema-agent/core-types"
import { TelemetryRecorder } from "@ema-agent/telemetry"
import type { TelemetryRecordInput } from "@ema-agent/telemetry"
import type { SqliteStorage } from "@ema-agent/storage-sql"

interface TelemetryRouteOptions {
  storage: SqliteStorage
}

interface TelemetryQuery {
  limit?: string
  requestId?: string
}

/**
 * Telemetry API。
 *
 * Developer 面板读取最近事件，也允许测试/调试时写入一条结构化事件。
 */
export function registerTelemetryRoutes(app: FastifyInstance, options: TelemetryRouteOptions): void {
  const recorder = new TelemetryRecorder(options.storage)

  app.get<{ Querystring: TelemetryQuery }>("/api/telemetry/events", async (request) => {
    if (request.query.requestId) {
      return {
        items: await options.storage.telemetry.listByRequest(asId<RequestId>(request.query.requestId)),
      }
    }

    return {
      items: await options.storage.telemetry.listRecent(Number(request.query.limit ?? 50)),
    }
  })

  app.post<{ Body: TelemetryRecordInput }>("/api/telemetry/events", async (request) => {
    await recorder.record(request.body)
    return { ok: true }
  })
}
