import { asId } from "@ema-agent/core-types"
import type { ModelDescriptor, ModelId } from "@ema-agent/core-types"
import {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_OUTPUT_TOKENS,
} from "@ema-agent/constants-core"

import type { LlmProviderSpec } from "../providers/spec.js"

/**
 * 从 provider 拉取可用模型列表。
 * 走 OpenAI 兼容的 GET /models 端点——openai / openai-compatible / gemini 均支持。
 * Anthropic 无标准 list endpoint，返回空数组（模型由用户手动添加）。
 */
export async function fetchModels(
  spec: LlmProviderSpec,
  signal?: AbortSignal,
): Promise<ModelDescriptor[]> {
  if (spec.kind === "anthropic") return []
  if (spec.kind === "local-dev") return []

  const url = `${spec.baseUrl.replace(/\/$/, "")}/models`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeader(spec),
    ...(spec.headers ?? {}),
  }

  const res = await fetch(url, { method: "GET", headers, signal })
  if (!res.ok) {
    throw new Error(`fetchModels failed for ${spec.id}: ${res.status} ${res.statusText}`)
  }

  const json = await res.json() as { data?: unknown[]; models?: unknown[] }
  const items: unknown[] = json.data ?? json.models ?? []

  return items.flatMap(item => parseModelItem(item, spec))
}

function buildAuthHeader(spec: LlmProviderSpec): Record<string, string> {
  if (!spec.apiKey) return {}
  if (spec.kind === "gemini") return { "x-goog-api-key": spec.apiKey }
  return { Authorization: `Bearer ${spec.apiKey}` }
}

function parseModelItem(item: unknown, spec: LlmProviderSpec): ModelDescriptor[] {
  if (typeof item !== "object" || item === null) return []
  const obj = item as Record<string, unknown>
  const id = String(obj.id ?? obj.name ?? "")
  if (!id) return []

  return [{
    id: asId<ModelId>(id),
    displayName: String(obj.displayName ?? obj.display_name ?? id),
    providerId: spec.id,
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      structuredOutput: false,
      promptCache: false,
      listModels: false,
      tts: false,
      stt: false,
      imageGen: false,
      videoGen: false,
      moderation: false,
    },
    contextWindow: Number(obj.context_window ?? obj.contextWindow ?? FALLBACK_CONTEXT_WINDOW),
    maxOutputTokens: Number(obj.max_output_tokens ?? obj.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS),
    source: "remote",
    updatedAt: Date.now(),
  }]
}
