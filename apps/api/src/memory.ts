import type { FastifyInstance } from "fastify"

import { EmaError, asId } from "@ema-agent/core-types"
import type { EmaMode, SessionId } from "@ema-agent/core-types"
import { MemoryPlanner } from "@ema-agent/memory"
import type { SqliteStorage } from "@ema-agent/storage-sql"

interface MemoryRouteOptions {
  storage: SqliteStorage
}

interface WriteFactBody {
  sessionId?: string
  kind?: "preference" | "skill" | "habit" | "project" | "note"
  content?: string
  confidence?: number
}

interface ContextRadarParams {
  sessionId: string
}

interface ContextRadarQuery {
  q?: string
  mode?: EmaMode
  maxTokens?: string
}

/**
 * Memory API。
 *
 * 提供 durable facts 写入、列表读取和 ContextRadar 预算视图。
 */
export function registerMemoryRoutes(app: FastifyInstance, options: MemoryRouteOptions): void {
  const planner = new MemoryPlanner(options.storage)

  app.post<{ Body: WriteFactBody }>("/api/memory/facts", async (request) => {
    const body = request.body
    if (!body.sessionId || !body.kind || !body.content) {
      throw new EmaError("bad_request", "sessionId、kind、content 是记忆写入必填项。", false)
    }

    return planner.writeFact({
      sessionId: asId<SessionId>(body.sessionId),
      kind: body.kind,
      content: body.content,
      confidence: body.confidence,
      source: "explicit",
    })
  })

  app.get<{ Params: ContextRadarParams }>("/api/sessions/:sessionId/memory/facts", async (request) => {
    return {
      items: await options.storage.memory.listFacts(asId<SessionId>(request.params.sessionId)),
    }
  })

  app.get<{ Params: ContextRadarParams; Querystring: ContextRadarQuery }>("/api/sessions/:sessionId/context-radar", async (request) => {
    return planner.plan({
      sessionId: asId<SessionId>(request.params.sessionId),
      mode: request.query.mode ?? "chat",
      query: request.query.q ?? "",
      maxTokens: request.query.maxTokens ? Number(request.query.maxTokens) : undefined,
    })
  })
}
