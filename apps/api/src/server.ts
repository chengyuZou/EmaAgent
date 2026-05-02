import cors from "@fastify/cors"
import Fastify from "fastify"

import { LlmRegistry } from "@ema-agent/llm"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import { registerProviderRoutes } from "./providers.js"
import { TurnEventStore } from "./turn-events.js"
import { registerTurnRoutes, TurnService } from "./turns.js"

export interface ApiServerOptions {
  storage: SqliteStorage
  llmRegistry?: LlmRegistry
  logger?: boolean
}

/**
 * API server 骨架。
 *
 * 后续这里接入本地 token、错误拦截、trace、真实服务实例生命周期。
 */
export async function buildApiServer(options: ApiServerOptions) {
  const app = Fastify({
    logger: options.logger ?? true,
  })

  await app.register(cors, {
    origin: true,
  })

  const eventStore = new TurnEventStore()
  const turnService = new TurnService(options.storage, eventStore)
  const llmRegistry = options.llmRegistry ?? new LlmRegistry()

  app.get("/api/health", async () => ({
    ok: true,
  }))

  registerTurnRoutes(app, turnService, eventStore)
  registerProviderRoutes(app, llmRegistry)

  return app
}
