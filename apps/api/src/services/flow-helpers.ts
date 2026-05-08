import { EmaError, asId } from "@ema-agent/core-types"
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatMessage,
  EmaMode,
  MessageContentBlock,
  MessageId,
  ModelId,
  ModelRole,
  ProviderId,
  RequestId,
  SessionId,
  SseEvent,
  StartTurnRequest,
  ToolCallId,
  TurnInputBlock,
} from "@ema-agent/core-types"
import { buildSystemPrompt } from "@ema-agent/prompts"
import type { LlmRegistry } from "@ema-agent/llm"
import type { SqliteStorage } from "@ema-agent/storage-sql"

export interface ResolvedModelBinding {
  role: ModelRole
  providerId: ProviderId
  modelId: ModelId
}

export interface ToolCallDraft {
  toolName: string
  argsText: string
}

export function resolveModelBinding(
  registry: LlmRegistry,
  role: ModelRole,
  modelOverride: ModelId | undefined,
): ResolvedModelBinding {
  const binding = registry.getBinding(role)

  if (modelOverride) {
    return {
      role,
      providerId: binding?.providerId ?? inferProviderIdFromModelId(modelOverride),
      modelId: modelOverride,
    }
  }

  if (!binding) {
    throw new EmaError("model_not_found", `没有为 ${role} 绑定模型。`, false)
  }

  return binding
}

function inferProviderIdFromModelId(modelId: ModelId): ProviderId {
  const [provider] = String(modelId).split("/")
  if (!provider) {
    throw new EmaError("bad_request", "临时模型覆盖必须使用 provider/model 格式，或先配置 role binding。", false)
  }
  return asId<ProviderId>(provider)
}

export function mapModeToRole(mode: EmaMode): ModelRole {
  return mode
}

export function getModeModelOverride(
  mode: EmaMode,
  overrides: StartTurnRequest["modelOverrides"] | undefined,
): ModelId | undefined {
  if (!overrides) return undefined
  if (mode === "agent") return overrides.agentModelId
  if (mode === "narrative") return overrides.narrativeModelId
  return overrides.chatModelId
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EmaError("internal_error", "Turn aborted.", true)
  }
}

export function inputToPlainText(input: readonly TurnInputBlock[]): string {
  return input
    .map((block) => {
      if (block.type === "text") return block.text
      if (block.type === "image_ref") return `[image:${block.attachmentId}]`
      if (block.type === "file_ref") return `[file:${block.attachmentId}]`
      return `[artifact:${block.artifactId}]`
    })
    .join("\n")
    .trim()
}

export async function createChatCompletionMessages(
  storage: SqliteStorage,
  sessionId: SessionId,
  mode: EmaMode,
  extraSystemContext?: string,
): Promise<ChatCompletionMessage[]> {
  const history = await storage.messages.listMessagesBySession(sessionId, {
    limit: 30,
    includeSystem: false,
  })

  return [
    {
      role: "system",
      content: buildSystemPrompt({ mode, recalledContext: extraSystemContext }),
    },
    ...history.items.map(toChatCompletionMessage).filter((m): m is ChatCompletionMessage => Boolean(m)),
  ]
}

function toChatCompletionMessage(message: ChatMessage): ChatCompletionMessage | undefined {
  const text = contentBlocksToPlainText(message.contentBlocks)
  if (text.trim() === "") return undefined

  if (message.role === "assistant") return { role: "assistant", content: text }
  if (message.role === "system") return { role: "system", content: text }
  return { role: "user", content: text }
}

function contentBlocksToPlainText(blocks: readonly MessageContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text": return block.text
        case "image": return `[image:${block.alt ?? block.url}]`
        case "attachment_ref": return `[attachment:${block.attachmentId}]`
        case "artifact_ref": return `[artifact:${block.artifact.title}]`
        case "tool_call": return `[tool_call:${block.toolName} ${JSON.stringify(block.args)}]`
        case "tool_result": return `[tool_result:${block.toolName} ${block.resultStr}]`
        case "permission_request": return `[permission_request:${block.toolName} ${block.summary}]`
        case "phase": return `[phase:${block.detail}]`
        case "retrieval": return `[retrieval:${block.source} ${block.content}]`
        case "compression": return `[compression:${block.content}]`
        case "audio": return `[audio:${block.transcript ?? block.url}]`
        case "image_gen": return `[image_gen:${block.prompt}]`
        case "emotion": return `[emotion:${block.label} ${block.reason}]`
        case "error": return `[error:${block.code} ${block.message}]`
        default: return ""
      }
    })
    .join("\n")
    .trim()
}

export function* mapLlmChunkToEvents(input: {
  chunk: ChatCompletionChunk
  requestId: RequestId
  sessionId: SessionId
  messageId: MessageId
  toolCalls: Map<ToolCallId, ToolCallDraft>
}): Iterable<SseEvent> {
  const at = Date.now()
  const delta = input.chunk.delta.content

  if (delta) {
    yield {
      type: "text_delta",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at,
      messageId: input.messageId,
      blockId: `text_${input.messageId}`,
      delta,
    }
  }

  for (const toolCall of input.chunk.toolCalls ?? []) {
    const current = input.toolCalls.get(toolCall.id)
    if (!current) {
      input.toolCalls.set(toolCall.id, {
        toolName: toolCall.toolName,
        argsText: toolCall.argumentsDelta,
      })
      yield {
        type: "tool_call_start",
        requestId: input.requestId,
        sessionId: input.sessionId,
        at,
        messageId: input.messageId,
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
      }
    } else {
      current.argsText += toolCall.argumentsDelta
    }

    if (toolCall.argumentsDelta) {
      yield {
        type: "tool_call_args",
        requestId: input.requestId,
        sessionId: input.sessionId,
        at,
        messageId: input.messageId,
        toolCallId: toolCall.id,
        argsDelta: toolCall.argumentsDelta,
      }
    }
  }

  if (input.chunk.finishReason === "tool_calls") {
    for (const [toolCallId, draft] of input.toolCalls) {
      yield {
        type: "tool_call_end",
        requestId: input.requestId,
        sessionId: input.sessionId,
        at,
        messageId: input.messageId,
        toolCallId,
        args: parseToolArgs(draft.argsText),
      }
    }
    input.toolCalls.clear()
  }
}

function parseToolArgs(value: string): Record<string, unknown> {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return { raw: value }
  }
}

export function createStageCueEvent(
  requestId: RequestId,
  sessionId: SessionId,
  source: Extract<Extract<SseEvent, { type: "stage_cue" }>["cue"]["source"], string>,
  cue: Omit<Extract<SseEvent, { type: "stage_cue" }>["cue"], "source">,
): SseEvent {
  return {
    type: "stage_cue",
    requestId,
    sessionId,
    at: Date.now(),
    cue: { source, ...cue },
  }
}
