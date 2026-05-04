import type { FastifyInstance } from "fastify"

import { EmaError, asId } from "@ema-agent/core-types"
import type {
  ModelId,
  ModelRole,
  ProviderId,
  ProviderKind,
} from "@ema-agent/core-types"
import type { LlmProviderConfig, ModelBinding } from "@ema-agent/llm"
import type { LlmRegistry } from "@ema-agent/llm"

interface ProviderRouteParams {
  providerId: string
}

interface ProviderPatchBody {
  displayName?: string
  kind?: ProviderKind
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
}

interface BindingBody {
  role?: ModelRole
  providerId?: string
  modelId?: string
}

/**
 * Provider / Model API 路由。
 *
 * 这层只负责 HTTP 协议转换：
 * - 读 provider 列表和模型目录。
 * - 刷新远端模型与健康检查。
 * - 保存单个 provider 的进程内设置。
 * - 保存 role -> model 的绑定。
 *
 * 注意：API Key 现在只进内存 registry，不写 SQLite；后续桌面端接系统密钥链。
 */
export function registerProviderRoutes(app: FastifyInstance, registry: LlmRegistry): void {
  app.get("/api/providers", async () => {
    return {
      items: registry.listProviders(),
      configs: registry.listProviderConfigs(),
    }
  })

  app.patch<{ Params: ProviderRouteParams; Body: ProviderPatchBody }>("/api/providers/:providerId", async (request) => {
    const providerId = toProviderId(request.params.providerId)
    const updated = registry.updateProvider(providerId, normalizeProviderPatch(request.body))
    return {
      provider: registry.listProviders().find((item) => item.id === providerId),
      config: updated,
    }
  })

  app.get<{ Params: ProviderRouteParams }>("/api/providers/:providerId/models", async (request) => {
    return { items: registry.listKnownModels(toProviderId(request.params.providerId)) }
  })

  app.post<{ Params: ProviderRouteParams }>("/api/providers/:providerId/refresh-models", async (request) => {
    const providerId = toProviderId(request.params.providerId)
    return { items: await registry.refreshModels(providerId) }
  })

  app.post<{ Params: ProviderRouteParams }>("/api/providers/:providerId/health", async (request) => {
    return registry.checkHealth(toProviderId(request.params.providerId))
  })

  app.get("/api/models", async () => {
    return { items: registry.listKnownModels() }
  })

  app.get("/api/models/bindings", async () => {
    return { bindings: registry.getBindingsSnapshot() }
  })

  app.put<{ Body: BindingBody }>("/api/models/bindings", async (request) => {
    const binding = normalizeBinding(request.body)
    registry.bindRole(binding)
    return {
      binding,
      bindings: registry.getBindingsSnapshot(),
    }
  })

  app.get("/api/llm/config", async () => registry.getConfigSnapshot())
}

function normalizeProviderPatch(body: ProviderPatchBody): Partial<LlmProviderConfig> {
  const patch: Partial<LlmProviderConfig> = {}

  if (body.displayName !== undefined) {
    patch.displayName = body.displayName.trim()
  }
  if (body.kind !== undefined) {
    patch.kind = body.kind
  }
  if (body.enabled !== undefined) {
    patch.enabled = Boolean(body.enabled)
  }
  if (body.baseUrl !== undefined) {
    patch.baseUrl = body.baseUrl.trim()
  }
  if (body.apiKey !== undefined && body.apiKey !== "********") {
    patch.apiKey = body.apiKey.trim() || undefined
  }
  if (body.headers !== undefined) {
    patch.headers = body.headers
  }

  return patch
}

function normalizeBinding(body: BindingBody): ModelBinding {
  if (!body.role || !body.providerId || !body.modelId) {
    throw new EmaError("bad_request", "role、providerId、modelId 都是必填项。", false)
  }

  return {
    role: body.role,
    providerId: toProviderId(body.providerId),
    modelId: asId<ModelId>(body.modelId),
  }
}

function toProviderId(value: string): ProviderId {
  return asId<ProviderId>(value)
}
