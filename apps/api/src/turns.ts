import { randomUUID } from "node:crypto"

import type { FastifyInstance, FastifyReply } from "fastify"

import { EmaError, asId, isEmaMode } from "@ema-agent/core-types"
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
  StartTurnRequest,
  StartTurnResponse,
  StepId,
  SseEvent,
  ToolCallId,
  TurnInputBlock,
  UsageView,
} from "@ema-agent/core-types"
import { estimateUsageCost } from "@ema-agent/llm"
import type { LlmRegistry } from "@ema-agent/llm"
import { NarrativeBridgeClient, narrativeResultToContext } from "@ema-agent/narrative"
import { PermissionEngine, createDefaultPermissionPolicy } from "@ema-agent/permission"
import { buildSystemPrompt } from "@ema-agent/prompts"
import { createWorkspaceScope } from "@ema-agent/sandbox"
import { SessionManager, SessionWriter, createFallbackTitle } from "@ema-agent/session"
import type { SqliteStorage } from "@ema-agent/storage-sql"
import { TelemetryRecorder } from "@ema-agent/telemetry"
import { BuiltinToolExecutor, ToolRegistry } from "@ema-agent/tool"

import { StreamAggregator } from "./stream-aggregator.js"
import { formatSseEvent, isTerminalEvent } from "./turn-events.js"
import type { TurnEventStore } from "./turn-events.js"

interface TurnRouteParams {
  requestId: string
}

interface BackgroundTurnInput {
  sessionId: StartTurnRequest["sessionId"]
  requestId: RequestId
  assistantMessageId: MessageId
  mode: EmaMode
  input: TurnInputBlock[]
  modelOverrides?: StartTurnRequest["modelOverrides"]
  abortSignal: AbortSignal
  shouldGenerateTitle: boolean
}

interface EnsureSessionResult {
  created: boolean
}

interface ResolvedModelBinding {
  role: ModelRole
  providerId: ProviderId
  modelId: ModelId
}

interface ToolCallDraft {
  toolName: string
  argsText: string
}

interface TurnServiceOptions {
  narrativeBridgeBaseUrl?: string
  narrativeBridgeToken?: string
}

/**
 * TurnService 是 POST /api/turns 的应用服务。
 *
 * 它只负责把一次 HTTP 请求翻译成 turn 生命周期：
 * 1. 校验输入并生成 request/message ID。
 * 2. 确保 session 存在。
 * 3. 调 SessionManager.beginTurn() 写入 turn 与用户消息。
 * 4. 发布 turn_started。
 * 5. 后台启动 turn 执行，并立刻把 streamUrl 返回给前端。
 */
export class TurnService {
  private readonly sessionManager: SessionManager
  private readonly sessionWriter: SessionWriter
  private readonly toolRegistry = new ToolRegistry()
  private readonly permissionEngine = new PermissionEngine(createDefaultPermissionPolicy())
  private readonly narrativeClient: NarrativeBridgeClient
  private readonly telemetry: TelemetryRecorder

  constructor(
    private readonly storage: SqliteStorage,
    private readonly eventStore: TurnEventStore,
    private readonly llmRegistry: LlmRegistry,
    private readonly workspaceRoot: string = process.cwd(),
    options: TurnServiceOptions = {},
  ) {
    this.sessionManager = new SessionManager(storage)
    this.sessionWriter = new SessionWriter(storage)
    this.narrativeClient = new NarrativeBridgeClient({
      baseUrl: options.narrativeBridgeBaseUrl,
      token: options.narrativeBridgeToken,
    })
    this.telemetry = new TelemetryRecorder(storage)
  }

  /**
   * 处理 POST /api/turns 请求，启动一个新的聊天 turn。
   */
  async startTurn(input: StartTurnRequest): Promise<StartTurnResponse> {
    const acceptedAt = Date.now()
    const normalizedInput = normalizeTurnInput(input)
    const requestId = createRequestId()
    const userMessageId = createMessageId()
    const assistantMessageId = createMessageId()

    const ensureSessionResult = await this.ensureSession(input, normalizedInput, acceptedAt)

    const userMessage = await this.createUserMessage({
      requestId,
      messageId: userMessageId,
      input: normalizedInput,
      createdAt: acceptedAt,
    })

    const beginResult = await this.sessionManager.beginTurn({
      sessionId: input.sessionId,
      requestId,
      mode: input.mode,
      userMessage,
    })

    this.eventStore.publish({
      type: "turn_started",
      requestId,
      sessionId: input.sessionId,
      at: acceptedAt,
      mode: input.mode,
      userMessageId,
      assistantMessageId,
      messageId: assistantMessageId,
    })
    this.startBackgroundTurn({
      sessionId: input.sessionId,
      requestId,
      assistantMessageId,
      mode: input.mode,
      input: normalizedInput,
      modelOverrides: input.modelOverrides,
      abortSignal: beginResult.abortSignal,
      shouldGenerateTitle: ensureSessionResult.created,
    })

    return {
      requestId,
      sessionId: input.sessionId,
      userMessageId,
      assistantMessageId,
      acceptedAt,
      streamUrl: `/api/turns/${encodeURIComponent(requestId)}/events`,
    }
  }

  private async ensureSession(input: StartTurnRequest, normalizedInput: readonly TurnInputBlock[], createdAt: number): Promise<EnsureSessionResult> {
    const existingSession = await this.storage.sessions.getById(input.sessionId)
    if (existingSession) {
      return { created: false }
    }

    await this.storage.sessions.create({
      id: input.sessionId,
      title: createInitialTitle(normalizedInput),
      lastMode: input.mode,
      createdAt,
    })

    return { created: true }
  }

  private async createUserMessage(input: {
    requestId: RequestId
    messageId: MessageId
    input: readonly TurnInputBlock[]
    createdAt: number
  }): Promise<ChatMessage> {
    return {
      id: input.messageId,
      role: "user",
      contentBlocks: await this.createUserContentBlocks(input.input),
      requestId: input.requestId,
      status: "complete",
      createdAt: input.createdAt,
    }
  }

  private async createUserContentBlocks(input: readonly TurnInputBlock[]): Promise<MessageContentBlock[]> {
    const blocks: MessageContentBlock[] = []

    for (const block of input) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text })
        continue
      }

      if (block.type === "image_ref" || block.type === "file_ref") {
        blocks.push({ type: "attachment_ref", attachmentId: block.attachmentId })
        continue
      }

      const artifact = await this.storage.artifacts.getArtifactById(block.artifactId)
      if (artifact) {
        blocks.push({ type: "artifact_ref", artifact: artifact.summary })
      } else {
        blocks.push({ type: "text", text: `[artifact:${block.artifactId}]` })
      }
    }

    return blocks
  }

  private startBackgroundTurn(input: BackgroundTurnInput): void {
    queueMicrotask(() => {
      void this.runTurn(input).catch((error: unknown) => {
        void this.failBackgroundTurn(input, error).catch(() => {
          // 后台兜底失败不能再向 HTTP 请求抛出；后续接入 logger/trace 后在这里记录。
        })
      })
    })
  }

  private async runTurn(input: BackgroundTurnInput): Promise<void> {
    await this.telemetry.record({
      requestId: input.requestId,
      sessionId: input.sessionId,
      type: "turn_started",
      payload: { mode: input.mode },
    })

    const aggregator = new StreamAggregator(this.sessionWriter, this.eventStore)
    const terminalEvent = await aggregator.run({
      sessionId: input.sessionId,
      requestId: input.requestId,
      assistantMessageId: input.assistantMessageId,
      abortSignal: input.abortSignal,
      events: this.createLlmTurnEvents({
        sessionId: input.sessionId,
        requestId: input.requestId,
        messageId: input.assistantMessageId,
        mode: input.mode,
        input: input.input,
        modelOverrides: input.modelOverrides,
        abortSignal: input.abortSignal,
      }),
    })

    if (terminalEvent?.type === "error") {
      await this.sessionManager.failTurn({
        sessionId: input.sessionId,
        requestId: input.requestId,
        error: new EmaError("internal_error", terminalEvent.message, terminalEvent.retryable),
      })
      return
    }

    await this.sessionManager.completeTurn({
      sessionId: input.sessionId,
      requestId: input.requestId,
      usage: terminalEvent?.type === "turn_completed" ? terminalEvent.usage : undefined,
    })

    await this.telemetry.record({
      requestId: input.requestId,
      sessionId: input.sessionId,
      type: "turn_completed",
      payload: { usage: terminalEvent?.type === "turn_completed" ? terminalEvent.usage : undefined },
    })

    if (input.shouldGenerateTitle) {
      await this.generateSessionTitle(input).catch(() => {
        // 标题生成是附加体验，失败不能反向影响已经完成的聊天 turn。
      })
    }
  }

  private async *createLlmTurnEvents(input: {
    sessionId: SessionId
    requestId: RequestId
    messageId: MessageId
    mode: EmaMode
    input: readonly TurnInputBlock[]
    modelOverrides?: StartTurnRequest["modelOverrides"]
    abortSignal: AbortSignal
  }): AsyncIterable<SseEvent> {
    const startedAt = Date.now()
    const stepId = createStepId()
    const binding = resolveModelBinding(this.llmRegistry, mapModeToRole(input.mode), getModeModelOverride(input.mode, input.modelOverrides))
    const userText = inputToPlainText(input.input)
    const narrativeContext = input.mode === "narrative"
      ? await this.loadNarrativeContext({
          requestId: input.requestId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          query: userText,
        })
      : undefined
    const messages = await this.createChatCompletionMessages(input.sessionId, input.mode, narrativeContext)
    const toolExecutor = new BuiltinToolExecutor({
      scope: createWorkspaceScope({
        rootDir: this.workspaceRoot,
        allowWrite: true,
        allowedCommands: ["node", "npm", "pnpm", "python", "python3", "conda"],
      }),
    })

    yield {
      type: "step_start",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: startedAt,
      stepId,
      stepType: "response",
      title: "生成回复",
    }

    yield createStageCueEvent(input.requestId, input.sessionId, "step", {
      expression: input.mode === "agent" ? "thinking" : input.mode === "narrative" ? "curious" : "neutral",
      mouth: "idle",
      priority: 20,
    })

    let fullText = ""
    let lastUsage: UsageView | undefined
    const toolCalls = new Map<ToolCallId, ToolCallDraft>()
    const assistantToolCalls: NonNullable<Extract<ChatCompletionMessage, { role: "assistant" }>["toolCalls"]> = []
    const toolResultMessages: ChatCompletionMessage[] = []

    for await (const chunk of this.llmRegistry.streamChat({
      providerId: binding.providerId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      modelId: binding.modelId,
      messages,
      stream: true,
      tools: input.mode === "agent" ? this.toolRegistry.toToolSpecs() : undefined,
      temperature: input.mode === "agent" ? 0.2 : 0.7,
      maxTokens: input.mode === "agent" ? 4096 : 2048,
    })) {
      throwIfAborted(input.abortSignal)

      for (const event of mapLlmChunkToEvents({
        chunk,
        requestId: input.requestId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        toolCalls,
      })) {
        if (event.type === "text_delta") {
          fullText += event.delta
        }
        yield event

        if (event.type === "tool_call_end") {
          const draft = toolCalls.get(event.toolCallId)
          assistantToolCalls.push({
            id: event.toolCallId,
            toolName: draft?.toolName ?? "tool",
            argumentsDelta: JSON.stringify(event.args),
          })

          for (const toolEvent of await this.executeAgentTool({
            requestId: input.requestId,
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: event.toolCallId,
            toolName: draft?.toolName ?? "tool",
            args: event.args,
            executor: toolExecutor,
          })) {
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

      if (chunk.usage) {
        lastUsage = chunk.usage
      }
    }

    if (toolResultMessages.length > 0) {
      for await (const event of this.createToolFollowupEvents({
        requestId: input.requestId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        model: binding,
        messages,
        assistantText: fullText,
        assistantToolCalls,
        toolResultMessages,
        abortSignal: input.abortSignal,
      })) {
        if (event.type === "text_delta") {
          fullText += event.delta
        }
        yield event
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
      durationMs: 1_200,
    })

    yield {
      type: "step_end",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      stepId,
      status: "completed",
    }

    yield {
      type: "turn_completed",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      usage: lastUsage
        ? estimateUsageCost({
            providerId: binding.providerId,
            modelId: binding.modelId,
            usage: lastUsage,
          })
        : undefined,
    }
  }

  private async loadNarrativeContext(input: {
    requestId: RequestId
    sessionId: SessionId
    messageId: MessageId
    query: string
  }): Promise<string | undefined> {
    this.eventStore.publish({
      type: "retrieval_start",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      messageId: input.messageId,
      source: "narrative",
    })

    const result = await this.narrativeClient.query({
      worldId: "default",
      sceneContext: "",
      query: input.query,
    })
    const context = narrativeResultToContext(result)

    this.eventStore.publish({
      type: "retrieval_end",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      messageId: input.messageId,
      source: "narrative",
      content: context || "未召回到剧情片段。",
    })

    return context || undefined
  }

  private async executeAgentTool(input: {
    requestId: RequestId
    sessionId: SessionId
    messageId: MessageId
    toolCallId: ToolCallId
    toolName: string
    args: Record<string, unknown>
    executor: BuiltinToolExecutor
  }): Promise<SseEvent[]> {
    const descriptor = this.toolRegistry.get(input.toolName)
    const evaluation = this.permissionEngine.evaluate({
      requestId: input.requestId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      summary: `${descriptor.displayName}：${summarizeToolArgs(input.args)}`,
      risk: descriptor.risk === "critical" ? "critical" : descriptor.risk,
      paths: extractPathArgs(input.args),
      writesFiles: descriptor.writesFiles,
      needsNetwork: descriptor.needsNetwork,
      params: input.args,
    })

    const events: SseEvent[] = []
    if (evaluation.decision !== "allow") {
      events.push({
        type: "permission_request",
        requestId: input.requestId,
        sessionId: input.sessionId,
        at: Date.now(),
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        summary: evaluation.reason,
        risk: evaluation.risk === "critical" ? "high" : evaluation.risk,
      })
      events.push({
        type: "tool_result",
        requestId: input.requestId,
        sessionId: input.sessionId,
        at: Date.now(),
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        success: false,
        resultStr: `工具需要用户确认：${evaluation.reason}`,
        durationMs: 0,
      })
      return events
    }

    const result = await input.executor.execute(input.toolName, input.args)
    events.push({
      type: "tool_result",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      success: result.success,
      resultStr: result.resultStr,
      durationMs: result.durationMs,
    })
    return events
  }

  private async *createToolFollowupEvents(input: {
    requestId: RequestId
    sessionId: SessionId
    messageId: MessageId
    model: ResolvedModelBinding
    messages: ChatCompletionMessage[]
    assistantText: string
    assistantToolCalls: NonNullable<Extract<ChatCompletionMessage, { role: "assistant" }>["toolCalls"]>
    toolResultMessages: ChatCompletionMessage[]
    abortSignal: AbortSignal
  }): AsyncIterable<SseEvent> {
    const followupMessages: ChatCompletionMessage[] = [
      ...input.messages,
      {
        role: "assistant",
        content: input.assistantText || null,
        toolCalls: input.assistantToolCalls,
      },
      ...input.toolResultMessages,
    ]

    for await (const chunk of this.llmRegistry.streamChat({
      providerId: input.model.providerId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      modelId: input.model.modelId,
      messages: followupMessages,
      stream: true,
      temperature: 0.2,
      maxTokens: 2048,
    })) {
      throwIfAborted(input.abortSignal)
      const delta = chunk.delta.content
      if (!delta) {
        continue
      }

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

  private async createChatCompletionMessages(sessionId: SessionId, mode: EmaMode, extraSystemContext?: string): Promise<ChatCompletionMessage[]> {
    const history = await this.storage.messages.listMessagesBySession(sessionId, {
      limit: 30,
      includeSystem: false,
    })

    return [
      {
        role: "system",
        content: buildSystemPrompt({
          mode,
          recalledContext: extraSystemContext,
        }),
      },
      ...history.items.map(toChatCompletionMessage).filter((message): message is ChatCompletionMessage => Boolean(message)),
    ]
  }

  private async generateSessionTitle(input: BackgroundTurnInput): Promise<void> {
    const userText = inputToPlainText(input.input)
    const fallbackTitle = createFallbackTitle(userText)
    const session = await this.storage.sessions.getById(input.sessionId)

    if (!session || session.titleStatus === "manual" || session.titleStatus === "generated") {
      return
    }

    try {
      const binding = resolveModelBinding(this.llmRegistry, "title", input.modelOverrides?.titleModelId)
      let title = ""

      for await (const chunk of this.llmRegistry.streamChat({
        providerId: binding.providerId,
        requestId: input.requestId,
        sessionId: input.sessionId,
        modelId: binding.modelId,
        messages: [
          {
            role: "system",
            content: "你负责给中文聊天会话生成短标题。只输出标题，不要解释。",
          },
          {
            role: "user",
            content: `请为这段用户首轮输入生成 4 到 18 个字的标题：\n${userText}`,
          },
        ],
        stream: true,
        temperature: 0.2,
        maxTokens: 64,
      })) {
        title += chunk.delta.content ?? ""
      }

      const cleanedTitle = normalizeGeneratedTitle(title, fallbackTitle)
      await this.sessionWriter.updateTitle(input.sessionId, cleanedTitle, "generated")
    } catch {
      await this.sessionWriter.updateTitle(input.sessionId, fallbackTitle, "fallback")
    }
  }

  private async failBackgroundTurn(input: BackgroundTurnInput, error: unknown): Promise<void> {
    const emaError = toEmaError(error)

    await this.telemetry.record({
      requestId: input.requestId,
      sessionId: input.sessionId,
      type: "turn_failed",
      level: "error",
      payload: {
        code: emaError.code,
        message: emaError.message,
      },
    })

    this.eventStore.publish({
      type: "error",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      code: emaError.code,
      message: emaError.message,
      retryable: emaError.retryable,
    })

    await this.sessionManager.failTurn({
      sessionId: input.sessionId,
      requestId: input.requestId,
      error: emaError,
    })
  }
}

/**
 * 在 Fastify 应用上注册 Turn 相关 HTTP 路由。
 *
 * 这不是注册全局变量，而是把 handler 挂到 app 的路由表上：
 * - POST /api/turns
 * - GET /api/turns/:requestId/events
 */
export function registerTurnRoutes(
  app: FastifyInstance,
  service: TurnService,
  eventStore: TurnEventStore,
): void {
  app.post<{ Body: StartTurnRequest }>("/api/turns", async (request, reply) => {
    reply.code(202)
    return service.startTurn(request.body)
  })

  app.get<{ Params: TurnRouteParams }>("/api/turns/:requestId/events", (request, reply) => {
    openSseStream(reply, eventStore, asId<RequestId>(request.params.requestId))
  })
}

// 开启 SSE 连接：先 replay 历史事件，再订阅后续事件。
function openSseStream(reply: FastifyReply, eventStore: TurnEventStore, requestId: RequestId): void {
  reply.hijack()
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  })
  reply.raw.write(": connected\n\n")

  let replaying = true
  let closed = false
  const pendingEvents: SseEvent[] = []

  const cleanup = eventStore.subscribe(requestId, (event) => {
    if (replaying) {
      pendingEvents.push(event)
      return
    }

    writeEventAndMaybeClose(reply, event, () => {
      closed = true
      cleanup()
    })
  })

  reply.raw.on("close", () => {
    closed = true
    cleanup()
  })

  for (const event of eventStore.getReplayEvents(requestId)) {
    if (closed) {
      return
    }
    writeEventAndMaybeClose(reply, event, () => {
      closed = true
      cleanup()
    })
  }

  replaying = false

  for (const event of pendingEvents) {
    if (closed) {
      return
    }
    writeEventAndMaybeClose(reply, event, () => {
      closed = true
      cleanup()
    })
  }

  if (!closed && eventStore.getTerminalEvent(requestId)) {
    closed = true
    cleanup()
    reply.raw.end()
  }
}

function writeEventAndMaybeClose(reply: FastifyReply, event: SseEvent, close: () => void): void {
  if (reply.raw.destroyed || reply.raw.closed) {
    close()
    return
  }

  reply.raw.write(formatSseEvent(event))

  if (isTerminalEvent(event)) {
    close()
    reply.raw.end()
  }
}

function normalizeTurnInput(input: StartTurnRequest): TurnInputBlock[] {
  if (!input.sessionId) {
    throw new EmaError("bad_request", "sessionId is required.", false)
  }

  if (!isEmaMode(input.mode)) {
    throw new EmaError("bad_request", "mode is invalid.", false)
  }

  const blocks = Array.isArray(input.input) ? input.input.filter(isNonEmptyInputBlock) : []
  const rawUserQuery = input.rawUserQuery?.trim()

  if (blocks.length === 0 && rawUserQuery) {
    return [{ type: "text", text: rawUserQuery }]
  }

  if (blocks.length === 0) {
    throw new EmaError("bad_request", "turn input cannot be empty.", false)
  }

  return blocks
}

function isNonEmptyInputBlock(block: TurnInputBlock): boolean {
  if (block.type === "text") {
    return block.text.trim().length > 0
  }
  return true
}

function createInitialTitle(input: readonly TurnInputBlock[]): string {
  const firstText = input.find((block): block is Extract<TurnInputBlock, { type: "text" }> => block.type === "text")?.text.trim()
  return createFallbackTitle(firstText ?? "")
}

function createRequestId(): RequestId {
  return asId<RequestId>(`req_${randomUUID()}`)
}

function createMessageId(): MessageId {
  return asId<MessageId>(`msg_${randomUUID()}`)
}

function createStepId(): StepId {
  return asId<StepId>(`step_${randomUUID()}`)
}

function resolveModelBinding(registry: LlmRegistry, role: ModelRole, modelOverride: ModelId | undefined): ResolvedModelBinding {
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

function mapModeToRole(mode: EmaMode): ModelRole {
  return mode
}

function getModeModelOverride(mode: EmaMode, overrides: StartTurnRequest["modelOverrides"] | undefined): ModelId | undefined {
  if (!overrides) {
    return undefined
  }
  if (mode === "agent") {
    return overrides.agentModelId
  }
  if (mode === "narrative") {
    return overrides.narrativeModelId
  }
  return overrides.chatModelId
}

function toChatCompletionMessage(message: ChatMessage): ChatCompletionMessage | undefined {
  const text = contentBlocksToPlainText(message.contentBlocks)

  if (text.trim() === "") {
    return undefined
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: text,
    }
  }

  if (message.role === "system") {
    return {
      role: "system",
      content: text,
    }
  }

  return {
    role: "user",
    content: text,
  }
}

function contentBlocksToPlainText(blocks: readonly MessageContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text
        case "image":
          return `[image:${block.alt ?? block.url}]`
        case "attachment_ref":
          return `[attachment:${block.attachmentId}]`
        case "artifact_ref":
          return `[artifact:${block.artifact.title}]`
        case "tool_call":
          return `[tool_call:${block.toolName} ${JSON.stringify(block.args)}]`
        case "tool_result":
          return `[tool_result:${block.toolName} ${block.resultStr}]`
        case "permission_request":
          return `[permission_request:${block.toolName} ${block.summary}]`
        case "step":
          return `[step:${block.detail}]`
        case "retrieval":
          return `[retrieval:${block.source} ${block.content}]`
        case "compression":
          return `[compression:${block.content}]`
        case "error":
          return `[error:${block.code} ${block.message}]`
      }
    })
    .join("\n")
    .trim()
}
function inputToPlainText(input: readonly TurnInputBlock[]): string {
  return input
    .map((block) => {
      if (block.type === "text") {
        return block.text
      }
      if (block.type === "image_ref") {
        return `[image:${block.attachmentId}]`
      }
      if (block.type === "file_ref") {
        return `[file:${block.attachmentId}]`
      }
      return `[artifact:${block.artifactId}]`
    })
    .join("\n")
    .trim()
}

function* mapLlmChunkToEvents(input: {
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
  if (!value.trim()) {
    return {}
  }

  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {
      raw: value,
    }
  }
}

function normalizeGeneratedTitle(value: string, fallbackTitle: string): string {
  const title = value.trim().replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ")
  if (!title) {
    return fallbackTitle
  }
  return title.length <= 24 ? title : `${title.slice(0, 24)}...`
}

function createStageCueEvent(
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
    cue: {
      source,
      ...cue,
    },
  }
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length <= 180 ? text : `${text.slice(0, 180)}...`
}

function extractPathArgs(args: Record<string, unknown>): string[] {
  const paths = [args.path, args.cwd, ...(Array.isArray(args.paths) ? args.paths : [])]
  return paths.filter((item): item is string => typeof item === "string")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EmaError("internal_error", "Turn aborted.", true)
  }
}

function toEmaError(error: unknown): EmaError {
  if (error instanceof EmaError) {
    return error
  }

  if (error instanceof Error) {
    return new EmaError("internal_error", error.message, true, {
      name: error.name,
      stack: error.stack,
    })
  }

  return new EmaError("unknown_error", "未知后台 Turn 错误", true, {
    raw: String(error),
  })
}
