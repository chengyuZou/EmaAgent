import type {
  ChatCompletionMessage,
  EmaMode,
  MessageId,
  PhaseId,
  RequestId,
  SessionId,
  SseEvent,
  StartTurnRequest,
  ToolCallId,
  TurnInputBlock,
  UsageView,
} from "@ema-agent/core-types"
import { estimateUsageCost } from "@ema-agent/llm"
import type { LlmRegistry } from "@ema-agent/llm"
import type { PermissionEngine } from "@ema-agent/permission"
import { BuiltinToolExecutor, type ToolRegistry } from "@ema-agent/tool"
import { createWorkspaceScope } from "@ema-agent/sandbox"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import {
  createChatCompletionMessages,
  createStageCueEvent,
  getModeModelOverride,
  mapLlmChunkToEvents,
  mapModeToRole,
  resolveModelBinding,
  throwIfAborted,
  type ToolCallDraft,
} from "./flow-helpers.js"

export interface AgentFlowInput {
  sessionId: SessionId
  requestId: RequestId
  messageId: MessageId
  phaseId: PhaseId
  mode: EmaMode
  input: readonly TurnInputBlock[]
  modelOverrides?: StartTurnRequest["modelOverrides"]
  abortSignal: AbortSignal
}

export async function* runAgentFlow(
  storage: SqliteStorage,
  llmRegistry: LlmRegistry,
  toolRegistry: ToolRegistry,
  permissionEngine: PermissionEngine,
  workspaceRoot: string,
  input: AgentFlowInput,
): AsyncIterable<SseEvent> {
  const binding = resolveModelBinding(llmRegistry, mapModeToRole(input.mode), getModeModelOverride(input.mode, input.modelOverrides))
  const messages = await createChatCompletionMessages(storage, input.sessionId, input.mode)
  const toolExecutor = new BuiltinToolExecutor({
    scope: createWorkspaceScope({
      rootDir: workspaceRoot,
      allowWrite: true,
      allowedCommands: ["node", "npm", "pnpm", "python", "python3", "conda"],
    }),
  })

  yield createStageCueEvent(input.requestId, input.sessionId, "phase", {
    expression: "thinking",
    mouth: "idle",
    priority: 20,
  })

  let fullText = ""
  let lastUsage: UsageView | undefined
  const toolCalls = new Map<ToolCallId, ToolCallDraft>()
  const assistantToolCalls: NonNullable<Extract<ChatCompletionMessage, { role: "assistant" }>["toolCalls"]> = []
  const toolResultMessages: ChatCompletionMessage[] = []

  // ── Think phase: LLM reasoning with tools ──
  for await (const chunk of llmRegistry.streamChat({
    providerId: binding.providerId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    modelId: binding.modelId,
    messages,
    stream: true,
    tools: toolRegistry.toToolSpecs(),
    temperature: 0.2,
    maxTokens: 4096,
  })) {
    throwIfAborted(input.abortSignal)

    for (const event of mapLlmChunkToEvents({
      chunk,
      requestId: input.requestId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCalls,
    })) {
      if (event.type === "text_delta") fullText += event.delta
      yield event

      if (event.type === "tool_call_end") {
        const draft = toolCalls.get(event.toolCallId)
        assistantToolCalls.push({
          id: event.toolCallId,
          toolName: draft?.toolName ?? "tool",
          argumentsDelta: JSON.stringify(event.args),
        })

        // ── Act phase: execute tool ──
        for (const toolEvent of await executeAgentTool(
          toolRegistry,
          permissionEngine,
          toolExecutor,
          {
            requestId: input.requestId,
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: event.toolCallId,
            toolName: draft?.toolName ?? "tool",
            args: event.args,
          },
        )) {
          yield toolEvent

          if (toolEvent.type === "tool_result") {
            toolResultMessages.push({
              role: "tool",
              toolCallId: toolEvent.toolCallId,
              toolName: toolEvent.toolName,
              content: toolEvent.resultStr,
            })
          }
        }
      }
    }

    if (chunk.usage) lastUsage = chunk.usage
  }

  // ── Tool followup: reflect after tool results ──
  if (toolResultMessages.length > 0) {
    const followupMessages: ChatCompletionMessage[] = [
      ...messages,
      { role: "assistant", content: fullText || null, toolCalls: assistantToolCalls },
      ...toolResultMessages,
    ]

    for await (const chunk of llmRegistry.streamChat({
      providerId: binding.providerId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      modelId: binding.modelId,
      messages: followupMessages,
      stream: true,
      temperature: 0.2,
      maxTokens: 2048,
    })) {
      throwIfAborted(input.abortSignal)
      const delta = chunk.delta.content
      if (!delta) continue

      fullText += delta
      yield {
        type: "text_delta",
        requestId: input.requestId,
        sessionId: input.sessionId,
        at: Date.now(),
        messageId: input.messageId,
        blockId: `text_${input.messageId}`,
        delta,
      }
    }
  }

  yield {
    type: "text_done",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    messageId: input.messageId,
    blockId: `text_${input.messageId}`,
    fullText,
  }

  yield createStageCueEvent(input.requestId, input.sessionId, "system", {
    expression: "happy",
    motion: "nod",
    mouth: "idle",
    priority: 10,
    durationMs: 1200,
  })

  yield {
    type: "turn_completed",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    usage: lastUsage
      ? estimateUsageCost({ providerId: binding.providerId, modelId: binding.modelId, usage: lastUsage })
      : undefined,
  }
}

// ─── agent-only helpers ───────────────────────────────────────────

async function executeAgentTool(
  toolRegistry: ToolRegistry,
  permissionEngine: PermissionEngine,
  executor: BuiltinToolExecutor,
  params: {
    requestId: RequestId
    sessionId: SessionId
    messageId: MessageId
    toolCallId: ToolCallId
    toolName: string
    args: Record<string, unknown>
  },
): Promise<SseEvent[]> {
  const descriptor = toolRegistry.get(params.toolName)
  const evaluation = permissionEngine.evaluate({
    requestId: params.requestId,
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    summary: `${descriptor.displayName}：${summarizeToolArgs(params.args)}`,
    risk: descriptor.risk === "critical" ? "critical" : descriptor.risk,
    paths: extractPathArgs(params.args),
    writesFiles: descriptor.writesFiles,
    needsNetwork: descriptor.needsNetwork,
    params: params.args,
  })

  const events: SseEvent[] = []
  if (evaluation.decision !== "allow") {
    events.push({
      type: "permission_request",
      requestId: params.requestId,
      sessionId: params.sessionId,
      at: Date.now(),
      messageId: params.messageId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      summary: evaluation.reason,
      risk: evaluation.risk === "critical" ? "high" : evaluation.risk,
    })
    events.push({
      type: "tool_result",
      requestId: params.requestId,
      sessionId: params.sessionId,
      at: Date.now(),
      messageId: params.messageId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      success: false,
      resultStr: `工具需要用户确认：${evaluation.reason}`,
      durationMs: 0,
    })
    return events
  }

  const result = await executor.execute(params.toolName, params.args)
  events.push({
    type: "tool_result",
    requestId: params.requestId,
    sessionId: params.sessionId,
    at: Date.now(),
    messageId: params.messageId,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    success: result.success,
    resultStr: result.resultStr,
    durationMs: result.durationMs,
  })
  return events
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length <= 180 ? text : `${text.slice(0, 180)}...`
}

function extractPathArgs(args: Record<string, unknown>): string[] {
  const paths = [args.path, args.cwd, ...(Array.isArray(args.paths) ? args.paths : [])]
  return paths.filter((item): item is string => typeof item === "string")
}
