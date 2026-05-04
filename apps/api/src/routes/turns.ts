import type { FastifyInstance, FastifyReply } from "fastify"

import { asId } from "@ema-agent/core-types"
import type { RequestId, SseEvent, StartTurnRequest } from "@ema-agent/core-types"

import type { TurnService } from "../services/turn-service.js"
import { formatSseEvent, isTerminalEvent } from "../infrastructure/turn-event-store.js"
import type { TurnEventStore } from "../infrastructure/turn-event-store.js"

interface TurnRouteParams {
  requestId: string
}

export function registerTurnRoutes(
  app: FastifyInstance,
  service: TurnService,
  eventStore: TurnEventStore,
): void {
  app.post<{ Body: StartTurnRequest }>("/api/turns", async (request, reply) => {
    reply.code(202)
    return service.startTurn(request.body)
  })

  app.get<{ Params: TurnRouteParams }>("/api/turns/:requestId/events", (request, reply) => {
    openSseStream(reply, eventStore, asId<RequestId>(request.params.requestId))
  })
}

function openSseStream(reply: FastifyReply, eventStore: TurnEventStore, requestId: RequestId): void {
  reply.hijack()
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  })
  reply.raw.write(": connected\n\n")

  let replaying = true
  let closed = false
  const pendingEvents: SseEvent[] = []

  const cleanup = eventStore.subscribe(requestId, (event) => {
    if (replaying) {
      pendingEvents.push(event)
      return
    }

    writeEventAndMaybeClose(reply, event, () => {
      closed = true
      cleanup()
    })
  })

  reply.raw.on("close", () => {
    closed = true
    cleanup()
  })

  for (const event of eventStore.getReplayEvents(requestId)) {
    if (closed) {
      return
    }
    writeEventAndMaybeClose(reply, event, () => {
      closed = true
      cleanup()
    })
  }

  replaying = false

  for (const event of pendingEvents) {
    if (closed) {
      return
    }
    writeEventAndMaybeClose(reply, event, () => {
      closed = true
      cleanup()
    })
  }

  if (!closed && eventStore.getTerminalEvent(requestId)) {
    closed = true
    cleanup()
    reply.raw.end()
  }
}

function writeEventAndMaybeClose(reply: FastifyReply, event: SseEvent, close: () => void): void {
  if (reply.raw.destroyed || reply.raw.closed) {
    close()
    return
  }

  reply.raw.write(formatSseEvent(event))

  if (isTerminalEvent(event)) {
    close()
    reply.raw.end()
  }
}
