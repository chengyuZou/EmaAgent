import type { FastifyInstance } from "fastify"

import { NarrativeBridgeClient } from "@ema-agent/narrative"
import type { NarrativeBridgeQuery } from "@ema-agent/core-types"

export interface NarrativeRouteOptions {
  bridgeBaseUrl?: string
  bridgeToken?: string
}

export function registerNarrativeRoutes(app: FastifyInstance, options: NarrativeRouteOptions = {}): void {
  const client = new NarrativeBridgeClient({
    baseUrl: options.bridgeBaseUrl,
    token: options.bridgeToken,
  })

  app.get("/api/narrative/health", async () => client.health())
  app.post<{ Body: NarrativeBridgeQuery }>("/api/narrative/query", async (request) => client.query(request.body))
}
