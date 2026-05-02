import type { FastifyInstance, FastifyReply } from "fastify"

import { asId } from "@ema-agent/core-types"
import type {
  RequestId,
  StartTurnRequest,
  StartTurnResponse,
} from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import type { TurnEventStore } from "./turn-events.js"

interface TurnRouteParams {
  requestId: string
}

/**
 * TurnService 骨架。
 *
 * 后续这里负责：
 * - 创建/读取 session
 * - beginTurn / completeTurn / failTurn
 * - 调用 LLM/tool/narrative
 * - 把内部事件交给 StreamAggregator
 */
export class TurnService {
  constructor(
    private readonly storage: SqliteStorage,
    private readonly eventStore: TurnEventStore,
  ) {}

  async startTurn(input: StartTurnRequest): Promise<StartTurnResponse> {
    void this.storage
    void this.eventStore

    const requestId = asId<RequestId>("")

    return {
      requestId,
      sessionId: input.sessionId,
      acceptedAt: 0,
      streamUrl: "",
    }
  }
}

export function registerTurnRoutes(
  app: FastifyInstance,
  service: TurnService,
  eventStore: TurnEventStore,
): void {
  app.post("/api/turns", async (request) => {
    void eventStore
    return service.startTurn(request.body as StartTurnRequest)
  })

  app.get<{ Params: TurnRouteParams }>("/api/turns/:requestId/events", (request, reply) => {
    openSseStream(reply, asId<RequestId>(request.params.requestId))
  })
}

function openSseStream(reply: FastifyReply, requestId: RequestId): void {
  void requestId

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  })
  reply.raw.end()
}
