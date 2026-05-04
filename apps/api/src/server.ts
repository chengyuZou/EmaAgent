import cors from "@fastify/cors"
import Fastify from "fastify"

import { EmaError, toUiErrorView } from "@ema-agent/core-types"
import { LlmRegistry, createDefaultLlmConfig } from "@ema-agent/llm"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import { registerArtifactRoutes } from "./artifacts.js"
import { registerAttachmentRoutes } from "./attachments.js"
import { registerEbdRoutes } from "./ebd.js"
import { registerMemoryRoutes } from "./memory.js"
import { registerNarrativeRoutes } from "./narrative.js"
import { registerProviderRoutes } from "./providers.js"
import { registerTelemetryRoutes } from "./telemetry.js"
import { TurnEventStore } from "./turn-events.js"
import { registerTurnRoutes, TurnService } from "./turns.js"

export interface ApiServerOptions {
  storage: SqliteStorage
  llmRegistry?: LlmRegistry
  logger?: boolean
  workspaceRoot?: string
  ebdBridgeBaseUrl?: string
  ebdBridgeToken?: string
  narrativeBridgeBaseUrl?: string
  narrativeBridgeToken?: string
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

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof EmaError && error.code === "bad_request" ? 400 : 500
    reply.code(status).send(toUiErrorView(error))
  })

  const eventStore = new TurnEventStore()
  const llmRegistry = options.llmRegistry ?? new LlmRegistry()
  if (!options.llmRegistry) {
    llmRegistry.applyConfig(createDefaultLlmConfig(process.env))
  }
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const turnService = new TurnService(options.storage, eventStore, llmRegistry, workspaceRoot, {
    narrativeBridgeBaseUrl: options.narrativeBridgeBaseUrl ?? process.env.EMA_NARRATIVE_BRIDGE_URL,
    narrativeBridgeToken: options.narrativeBridgeToken ?? process.env.EMA_NARRATIVE_BRIDGE_TOKEN,
  })

  app.get("/api/health", async () => ({
    ok: true,
  }))

  registerTurnRoutes(app, turnService, eventStore)
  registerProviderRoutes(app, llmRegistry)
  registerArtifactRoutes(app, {
    storage: options.storage,
    workspaceRoot,
  })
  registerAttachmentRoutes(app, {
    storage: options.storage,
  })
  registerEbdRoutes(app, {
    bridgeBaseUrl: options.ebdBridgeBaseUrl ?? process.env.EMA_EBD_BRIDGE_URL,
    bridgeToken: options.ebdBridgeToken ?? process.env.EMA_EBD_BRIDGE_TOKEN,
  })
  registerMemoryRoutes(app, {
    storage: options.storage,
  })
  registerNarrativeRoutes(app, {
    bridgeBaseUrl: options.narrativeBridgeBaseUrl ?? process.env.EMA_NARRATIVE_BRIDGE_URL,
    bridgeToken: options.narrativeBridgeToken ?? process.env.EMA_NARRATIVE_BRIDGE_TOKEN,
  })
  registerTelemetryRoutes(app, {
    storage: options.storage,
  })

  return app
}
