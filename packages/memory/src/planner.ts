import { randomUUID } from "node:crypto"

import type { ContextBlock } from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import type { ContextBudget, ContextRadarView, RecallPlannerInput, WriteMemoryFactInput } from "./types.js"

/**
 * MemoryPlanner 负责 V1 的 durable facts、rolling summary 和召回预算。
 *
 * 它不做向量检索，也不做图检索；现在只用 SQLite facts + summary + 最近消息
 * 组成可解释的 ContextRadar。
 */
export class MemoryPlanner {
  constructor(private readonly storage: SqliteStorage) {}

  async writeFact(input: WriteMemoryFactInput) {
    return this.storage.memory.upsertFact({
      id: `mem_${randomUUID()}`,
      sessionId: input.sessionId,
      kind: input.kind,
      content: input.content,
      confidence: input.confidence ?? 0.8,
      source: input.source ?? "explicit",
    })
  }

  async updateSummary(sessionId: RecallPlannerInput["sessionId"], summaryText: string, coveredMessageCount: number) {
    return this.storage.memory.saveSummary({
      sessionId,
      summaryText,
      tokenCount: estimateTokens(summaryText),
      coveredMessageCount,
    })
  }

  async plan(input: RecallPlannerInput): Promise<ContextRadarView> {
    const maxTokens = input.maxTokens ?? 8_000
    const [summary, facts, messages] = await Promise.all([
      this.storage.memory.getSummary(input.sessionId),
      this.storage.memory.searchFacts(input.sessionId, input.query, 8),
      this.storage.messages.listMessagesBySession(input.sessionId, { limit: 12, includeSystem: false }),
    ])

    const blocks: ContextBlock[] = []

    if (summary) {
      blocks.push(toBlock("rolling_summary", summary.summaryText, 80))
    }

    for (const fact of facts) {
      blocks.push(toBlock("user_profile", fact.content, Math.round(fact.confidence * 100)))
    }

    const recentText = messages.items
      .map((message) => `${message.role}: ${message.contentBlocks.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("\n")}`)
      .join("\n")
      .trim()
    if (recentText) {
      blocks.push(toBlock("recent_messages", recentText, 60))
    }

    const selected = fitBudget(blocks.sort((a, b) => b.priority - a.priority), maxTokens)
    const budget = createBudget(selected, maxTokens)

    return {
      sessionId: input.sessionId,
      mode: input.mode,
      query: input.query,
      budget,
      blocks: selected,
      summary: summary ?? undefined,
      sourceStats: createSourceStats(selected),
    }
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function inspectCompaction(blocks: readonly ContextBlock[], maxTokens: number): ContextBudget {
  return createBudget(fitBudget([...blocks], maxTokens), maxTokens)
}

function toBlock(source: ContextBlock["source"], content: string, priority: number): ContextBlock {
  return {
    source,
    priority,
    content,
    tokenEstimate: estimateTokens(content),
  }
}

function fitBudget(blocks: ContextBlock[], maxTokens: number): ContextBlock[] {
  const selected: ContextBlock[] = []
  let used = 0

  for (const block of blocks) {
    if (used + block.tokenEstimate > maxTokens) {
      continue
    }
    selected.push(block)
    used += block.tokenEstimate
  }

  return selected
}

function createBudget(blocks: readonly ContextBlock[], maxTokens: number): ContextBudget {
  const usedTokens = blocks.reduce((sum, block) => sum + block.tokenEstimate, 0)
  const reservedOutputTokens = Math.min(2_048, Math.floor(maxTokens * 0.25))
  return {
    maxTokens,
    reservedOutputTokens,
    usedTokens,
    remainingTokens: Math.max(0, maxTokens - reservedOutputTokens - usedTokens),
    compacted: usedTokens > maxTokens - reservedOutputTokens,
  }
}

function createSourceStats(blocks: readonly ContextBlock[]): ContextRadarView["sourceStats"] {
  const stats: ContextRadarView["sourceStats"] = {}
  for (const block of blocks) {
    const current = stats[block.source] ?? { count: 0, tokens: 0 }
    stats[block.source] = {
      count: current.count + 1,
      tokens: current.tokens + block.tokenEstimate,
    }
  }
  return stats
}
