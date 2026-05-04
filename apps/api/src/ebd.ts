import type { FastifyInstance } from "fastify"

import { EbdBridgeClient } from "@ema-agent/ebd"
import type { EmbedRequest, RerankRequest } from "@ema-agent/ebd"

export interface EbdRouteOptions {
  bridgeBaseUrl?: string
  bridgeToken?: string
}

/**
 * Embedding / rerank API。
 *
 * 这里是 TS sidecar 到 Python compute bridge 的薄封装。
 */
export function registerEbdRoutes(app: FastifyInstance, options: EbdRouteOptions = {}): void {
  const client = new EbdBridgeClient({
    baseUrl: options.bridgeBaseUrl,
    token: options.bridgeToken,
  })

  app.get("/api/ebd/health", async () => client.health())

  app.post<{ Body: EmbedRequest }>("/api/ebd/embed", async (request) => {
    return client.embed(request.body)
  })

  app.post<{ Body: RerankRequest }>("/api/ebd/rerank", async (request) => {
    return client.rerank(request.body)
  })
}
