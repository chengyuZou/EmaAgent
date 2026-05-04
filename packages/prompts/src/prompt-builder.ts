import type { EmaMode } from "@ema-agent/core-types"

import { AGENT_MODE_PROMPT } from "./agent-mode-prompt.js"
import { CHAT_MODE_PROMPT } from "./chat-mode-prompt.js"
import { EMA_PERSONA_PROMPT } from "./ema-prompt.js"
import { NARRATIVE_MODE_PROMPT } from "./narrative-mode-prompt.js"
import { EMA_WORLD_PROMPT } from "./world-prompt.js"

export interface BuildSystemPromptInput {
  /** 本轮 turn 的模式，同一个 session 可以逐轮切换。 */
  mode: EmaMode
  /** narrative、memory、attachment 等模块召回出的上下文。 */
  recalledContext?: string
  /** 是否注入世界观；默认 true，后续可由预算系统关闭。 */
  includeWorld?: boolean
  /** 额外系统约束，供 API 层临时追加。 */
  extraInstructions?: readonly string[]
}

/**
 * 构建主模型 system prompt。
 * 这是纯函数：不读文件、不查数据库、不调用模型。API 层只需要把 mode 和召回上下文传进来。
 * @returns 完整的 system prompt，包含艾玛人设、世界观（可选）、模式规则、召回上下文（如果有）和额外约束（如果有）。
 */
export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const sections = [
    section("艾玛常驻人设", EMA_PERSONA_PROMPT),
    input.includeWorld === false ? undefined : section("世界观常识", EMA_WORLD_PROMPT),
    section("模式规则", getModePrompt(input.mode)),
    createRecalledContextSection(input.recalledContext),
    createExtraInstructionsSection(input.extraInstructions),
  ]

  return sections.filter(isNonEmptyString).join("\n\n").trim()
}

/**
 * 取指定模式的规则 Prompt。
 */
export function getModePrompt(mode: EmaMode): string {
  if (mode === "agent") {
    return AGENT_MODE_PROMPT
  }

  if (mode === "narrative") {
    return NARRATIVE_MODE_PROMPT
  }

  return CHAT_MODE_PROMPT
}

function section(title: string, content: string): string {
  return `## ${title}\n${content.trim()}`
}

/**
 * 创建召回上下文部分。
 * @returns 召回上下文部分的 prompt，如果内容为空则返回 undefined
 */
function createRecalledContextSection(recalledContext: string | undefined): string | undefined {
  const normalized = recalledContext?.trim()
  if (!normalized) {
    return undefined
  }

  return section(
    "召回上下文",
    [
      "以下内容由记忆、附件或 narrative bridge 召回。",
      "回答时优先使用这些内容；如果内容不足，要明确说明。",
      "",
      normalized,
    ].join("\n"),
  )
}

function createExtraInstructionsSection(extraInstructions: readonly string[] | undefined): string | undefined {
  const normalized = extraInstructions?.map((item) => item.trim()).filter(Boolean)
  if (!normalized || normalized.length === 0) {
    return undefined
  }

  return section("额外系统约束", normalized.map((item, index) => `${index + 1}. ${item}`).join("\n"))
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0
}
