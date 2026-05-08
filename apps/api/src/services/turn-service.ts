import { randomUUID } from "node:crypto"

import { EmaError, asId, isEmaMode } from "@ema-agent/core-types"
import type {
  EmaMode,
  MessageId,
  PhaseId,
  RequestId,
  SessionId,
  StartTurnRequest,
  StartTurnResponse,
  SseEvent,
  TurnInputBlock,
} from "@ema-agent/core-types"
import type { LlmRegistry } from "@ema-agent/llm"
import type { NarrativeBridgeClient } from "@ema-agent/narrative"
import type { PermissionEngine } from "@ema-agent/permission"
import { SessionManager, SessionWriter, createFallbackTitle } from "@ema-agent/session"
import type { SqliteStorage } from "@ema-agent/storage-sql"
import { TelemetryRecorder } from "@ema-agent/telemetry"
import type { ToolRegistry } from "@ema-agent/tool"

import { StreamAggregator } from "../infrastructure/stream-aggregator.js"
import type { TurnEventStore } from "../infrastructure/turn-event-store.js"
import { runChatFlow } from "./chat-flow.js"
import { runAgentFlow } from "./agent-flow.js"
import { runNarrativeFlow } from "./narrative-flow.js"
import {
  inputToPlainText,
  resolveModelBinding,
} from "./flow-helpers.js"

// ═══════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════

interface BackgroundTurnInput {
  sessionId: SessionId
  requestId: RequestId
  assistantMessageId: MessageId
  mode: EmaMode
  input: TurnInputBlock[]
  modelOverrides?: StartTurnRequest["modelOverrides"]
  abortSignal: AbortSignal
  shouldGenerateTitle: boolean
}

export interface TurnServiceOptions {
  narrativeBridgeBaseUrl?: string
  narrativeBridgeToken?: string
}

// ═══════════════════════════════════════════════════════════════
// TurnService — pure orchestration, delegates flows
// ═══════════════════════════════════════════════════════════════

export class TurnService {
  private readonly sessionManager: SessionManager
  private readonly sessionWriter: SessionWriter
  private readonly telemetry: TelemetryRecorder

  constructor(
    private readonly storage: SqliteStorage,
    private readonly eventStore: TurnEventStore,
    private readonly llmRegistry: LlmRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionEngine: PermissionEngine,
    private readonly narrativeClient: NarrativeBridgeClient,
    private readonly workspaceRoot: string = process.cwd(),
  ) {
    this.sessionManager = new SessionManager(storage)
    this.sessionWriter = new SessionWriter(storage)
    this.telemetry = new TelemetryRecorder(storage)
  }

  // ── Public API ─────────────────────────────────────────────

  async startTurn(input: StartTurnRequest): Promise<StartTurnResponse> {
    const acceptedAt = Date.now()
    const normalizedInput = normalizeTurnInput(input)
    const requestId = createRequestId()

    const ensureResult = await this.sessionManager.ensureSession(input.sessionId, {
      title: createFallbackTitle(inputToPlainText(normalizedInput)),
      mode: input.mode,
    })

    const beginResult = await this.sessionManager.beginTurn({
      sessionId: input.sessionId,
      requestId,
      mode: input.mode,
      userInputBlocks: normalizedInput,
    })

    this.eventStore.publish({
      type: "turn_started",
      requestId,
      sessionId: input.sessionId,
      at: acceptedAt,
      mode: input.mode,
      userMessageId: beginResult.userMessageId,
      assistantMessageId: beginResult.assistantMessageId,
    })

    this.startBackgroundTurn({
      sessionId: input.sessionId,
      requestId,
      assistantMessageId: beginResult.assistantMessageId,
      mode: input.mode,
      input: normalizedInput,
      modelOverrides: input.modelOverrides,
      abortSignal: beginResult.abortSignal,
      shouldGenerateTitle: ensureResult.created,
    })

    return {
      requestId,
      sessionId: input.sessionId,
      userMessageId: beginResult.userMessageId,
      assistantMessageId: beginResult.assistantMessageId,
      acceptedAt,
      streamUrl: `/api/turns/${encodeURIComponent(requestId)}/events`,
    }
  }

  // ── Background execution ───────────────────────────────────

  private startBackgroundTurn(input: BackgroundTurnInput): void {
    queueMicrotask(() => {
      void this.runTurn(input).catch((error: unknown) => {
        void this.failBackgroundTurn(input, error).catch(() => {})
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
      events: this.createLlmTurnEvents(input),
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
      await this.generateSessionTitle(input).catch(() => {})
    }
  }

  // ── Flow dispatch ──────────────────────────────────────────

  private async *createLlmTurnEvents(input: BackgroundTurnInput): AsyncIterable<SseEvent> {
    const startedAt = Date.now()
    const phaseId = createPhaseId()
    const flowInput = {
      sessionId: input.sessionId,
      requestId: input.requestId,
      messageId: input.assistantMessageId,
      phaseId,
      mode: input.mode,
      input: input.input,
      modelOverrides: input.modelOverrides,
      abortSignal: input.abortSignal,
    }

    yield {
      type: "phase_start" as const,
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: startedAt,
      phaseId,
      phase: input.mode === "agent" ? "think" as const : "think" as const,
      title: input.mode === "agent" ? "Agent 执行" : input.mode === "narrative" ? "剧情生成" : "生成回复",
    }

    switch (input.mode) {
      case "chat":
        yield* runChatFlow(this.storage, this.llmRegistry, flowInput)
        break
      case "agent":
        yield* runAgentFlow(this.storage, this.llmRegistry, this.toolRegistry, this.permissionEngine, this.workspaceRoot, flowInput)
        break
      case "narrative":
        yield* runNarrativeFlow(this.storage, this.llmRegistry, this.narrativeClient, this.eventStore, flowInput)
        break
    }

    yield {
      type: "phase_end" as const,
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      phaseId,
      status: "completed",
    }
  }

  // ── Title generation ───────────────────────────────────────

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
          { role: "system", content: "你负责给中文聊天会话生成短标题。只输出标题，不要解释。" },
          { role: "user", content: `请为这段用户首轮输入生成 4 到 18 个字的标题：\n${userText}` },
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

  // ── Error handling ─────────────────────────────────────────

  private async failBackgroundTurn(input: BackgroundTurnInput, error: unknown): Promise<void> {
    const emaError = toEmaError(error)

    await this.telemetry.record({
      requestId: input.requestId,
      sessionId: input.sessionId,
      type: "turn_failed",
      level: "error",
      payload: { code: emaError.code, message: emaError.message },
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

// ═══════════════════════════════════════════════════════════════
// Pure helpers (no DB, no I/O)
// ═══════════════════════════════════════════════════════════════

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
  if (block.type === "text") return block.text.trim().length > 0
  return true
}

function createRequestId(): RequestId {
  return asId<RequestId>(`req_${randomUUID()}`)
}

function createPhaseId(): PhaseId {
  return asId<PhaseId>(`phase_${randomUUID()}`)
}

function normalizeGeneratedTitle(value: string, fallbackTitle: string): string {
  const title = value.trim().replace(/^["'""]+|["'""]+$/g, "").replace(/\s+/g, " ")
  if (!title) return fallbackTitle
  return title.length <= 24 ? title : `${title.slice(0, 24)}...`
}

function toEmaError(error: unknown): EmaError {
  if (error instanceof EmaError) return error
  if (error instanceof Error) {
    return new EmaError("internal_error", error.message, true, { name: error.name, stack: error.stack })
  }
  return new EmaError("unknown_error", "未知后台 Turn 错误", true, { raw: String(error) })
}
