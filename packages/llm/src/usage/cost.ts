import { DEFAULT_PRICING } from "@ema-agent/constants-core"
import type { ModelId, ProviderId, UsageView } from "@ema-agent/core-types"

/**
 * 在 UsageView 基础上追加 costUsd 估算。
 * modelId 是远端模型名（不含 providerId 前缀）。
 */
export function estimateUsageCost(params: {
  providerId: ProviderId
  modelId: ModelId
  usage: UsageView
}): UsageView {
  const pricing = DEFAULT_PRICING[String(params.modelId)]
  if (!pricing) return params.usage

  const costUsd =
    (params.usage.inputTokens  / 1_000_000) * pricing.inputPer1M +
    (params.usage.outputTokens / 1_000_000) * pricing.outputPer1M

  return { ...params.usage, costUsd }
}
