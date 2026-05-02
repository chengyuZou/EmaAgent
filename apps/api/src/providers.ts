import type { FastifyInstance } from "fastify"

import type { ModelBinding } from "@ema-agent/llm"
import type { LlmRegistry } from "@ema-agent/llm"

/**
 * Provider / Model API 路由骨架。
 *
 * 后续这里负责 provider 列表、模型刷新、健康检查和角色绑定。
 */
export function registerProviderRoutes(app: FastifyInstance, registry: LlmRegistry): void {
  app.get("/api/providers", async () => {
    void registry
    return { items: [] }
  })

  app.get("/api/providers/:providerId/models", async () => {
    return { items: [] }
  })

  app.post("/api/providers/:providerId/refresh-models", async () => {
    return { items: [] }
  })

  app.post("/api/providers/:providerId/health", async () => {
    return { status: "unknown" }
  })

  app.get("/api/models", async () => {
    return { items: [] }
  })

  app.get("/api/models/bindings", async () => {
    return { bindings: {} }
  })

  app.put("/api/models/bindings", async (request) => {
    return {
      binding: request.body as ModelBinding,
      bindings: {},
    }
  })
}
