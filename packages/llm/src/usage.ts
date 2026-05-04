import { EmaError } from "@ema-agent/core-types"
import type { ModelId, ProviderId, UsageView } from "@ema-agent/core-types"

export interface ModelPrice {
  providerId: ProviderId
  modelPrefix: string
  inputPer1M: number
  outputPer1M: number
}

export interface UsageCostResult extends UsageView {
  providerId: ProviderId
  modelId: ModelId
  estimated: boolean
}

const DEFAULT_PRICES: readonly Omit<ModelPrice, "providerId">[] = [
  { modelPrefix: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6 },
  { modelPrefix: "claude-3-5-sonnet", inputPer1M: 3, outputPer1M: 15 },
  { modelPrefix: "gemini-1.5-pro", inputPer1M: 1.25, outputPer1M: 5 },
  { modelPrefix: "deepseek-chat", inputPer1M: 0.14, outputPer1M: 0.28 },
]

/**
 * 估算模型用量成本。
 *
 * 价格表只做 UI 粗略提示，真正账单以 provider 后台为准。
 */
export function estimateUsageCost(input: {
  providerId: ProviderId
  modelId: ModelId
  usage: UsageView
  prices?: readonly ModelPrice[]
}): UsageCostResult {
  const price = findPrice(input.providerId, input.modelId, input.prices)
  const costUsd = price
    ? (input.usage.inputTokens / 1_000_000) * price.inputPer1M + (input.usage.outputTokens / 1_000_000) * price.outputPer1M
    : undefined

  return {
    ...input.usage,
    costUsd,
    providerId: input.providerId,
    modelId: input.modelId,
    estimated: Boolean(price),
  }
}

export function normalizeProviderError(error: unknown): EmaError {
  if (error instanceof EmaError) {
    return error
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (message.includes("401") || message.includes("auth")) {
      return new EmaError("provider_unavailable", error.message, false)
    }
    if (message.includes("429") || message.includes("rate")) {
      return new EmaError("rate_limited", error.message, true)
    }
    if (message.includes("model")) {
      return new EmaError("model_not_found", error.message, false)
    }
    return new EmaError("provider_unavailable", error.message, true)
  }

  return new EmaError("unknown_error", String(error), true)
}

function findPrice(providerId: ProviderId, modelId: ModelId, prices: readonly ModelPrice[] | undefined): ModelPrice | undefined {
  const rawModel = String(modelId)
  const configured = prices?.find((price) => price.providerId === providerId && rawModel.includes(price.modelPrefix))
  if (configured) {
    return configured
  }

  const fallback = DEFAULT_PRICES.find((price) => rawModel.includes(price.modelPrefix))
  return fallback
    ? {
        ...fallback,
        providerId,
      }
    : undefined
}
