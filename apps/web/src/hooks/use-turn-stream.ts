import type {
  RequestId,
  StartTurnResponse,
  SseEvent,
} from "@ema-agent/core-types"

type EventSourceMessage = { data: string }

interface EventSourceLike {
  onerror: ((event: unknown) => void) | null
  addEventListener(type: string, listener: (event: EventSourceMessage) => void): void
  close(): void
}

export interface EventSourceConstructor {
  new (url: string): EventSourceLike
}

export type TurnStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "completed"
  | "failed"

export interface TurnStreamState {
  status: TurnStreamStatus
  requestId?: RequestId
  events: SseEvent[]
  textByMessageId: Record<string, string>
  lastEvent?: SseEvent
  error?: {
    code: string
    message: string
  }
}

export interface UseTurnStreamOptions {
  apiBaseUrl?: string
  EventSource?: EventSourceConstructor
  onEvent?: (event: SseEvent, state: TurnStreamState) => void
}

export interface TurnStreamController {
  getState(): TurnStreamState
  subscribe(listener: (state: TurnStreamState) => void): () => void
  start(response: StartTurnResponse): void
  connect(streamUrl: string, requestId?: RequestId): void
  close(): void
}

/**
 * 前端 turn stream 控制器。
 *
 * 这里不依赖 React hook API，名字保留 useTurnStream 是为了之后页面层直接接入。
 * 它负责：
 * - 用 StartTurnResponse 连接 SSE。
 * - 累积事件列表。
 * - 拼接 text_delta / text_done。
 * - 在 turn_completed / error 后关闭连接。
 */
export function useTurnStream(options: UseTurnStreamOptions = {}): TurnStreamController {
  let state = createInitialState()
  let eventSource: EventSourceLike | undefined
  const listeners = new Set<(state: TurnStreamState) => void>()

  const setState = (patch: Partial<TurnStreamState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state)
    }
  }

  const applyEvent = (event: SseEvent) => {
    const nextState = reduceEvent(state, event)
    state = nextState
    options.onEvent?.(event, state)
    for (const listener of listeners) {
      listener(state)
    }
    if (event.type === "turn_completed" || event.type === "error") {
      eventSource?.close()
      eventSource = undefined
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    start(response) {
      this.connect(response.streamUrl, response.requestId)
    },
    connect(streamUrl, requestId) {
      eventSource?.close()
      const EventSourceCtor = resolveEventSource(options.EventSource)
      const url = resolveStreamUrl(options.apiBaseUrl, streamUrl)

      setState({
        status: "connecting",
        requestId,
        events: [],
        textByMessageId: {},
        lastEvent: undefined,
        error: undefined,
      })

      eventSource = new EventSourceCtor(url)
      eventSource.onerror = (event) => {
        setState({
          status: "failed",
          error: {
            code: "stream_error",
            message: event instanceof Error ? event.message : "SSE 连接失败。",
          },
        })
        eventSource?.close()
        eventSource = undefined
      }

      for (const eventType of SSE_EVENT_TYPES) {
        eventSource.addEventListener(eventType, (message) => {
          applyEvent(parseSseEvent(message.data))
        })
      }
    },
    close() {
      eventSource?.close()
      eventSource = undefined
      setState({ status: state.status === "completed" ? "completed" : "idle" })
    },
  }
}

function createInitialState(): TurnStreamState {
  return {
    status: "idle",
    events: [],
    textByMessageId: {},
  }
}

export function getLatestAssistantText(state: TurnStreamState): string {
  const entries = Object.entries(state.textByMessageId)
  return entries[entries.length - 1]?.[1] ?? ""
}

function reduceEvent(state: TurnStreamState, event: SseEvent): TurnStreamState {
  const nextTextByMessageId = { ...state.textByMessageId }

  if (event.type === "text_delta") {
    nextTextByMessageId[event.messageId] = `${nextTextByMessageId[event.messageId] ?? ""}${event.delta}`
  }

  if (event.type === "text_done") {
    nextTextByMessageId[event.messageId] = event.fullText
  }

  return {
    ...state,
    status: event.type === "turn_completed" ? "completed" : event.type === "error" ? "failed" : "streaming",
    requestId: event.requestId,
    events: [...state.events, event],
    textByMessageId: nextTextByMessageId,
    lastEvent: event,
    error: event.type === "error"
      ? {
          code: event.code,
          message: event.message,
        }
      : state.error,
  }
}

function parseSseEvent(data: string): SseEvent {
  return JSON.parse(data) as SseEvent
}

function resolveStreamUrl(apiBaseUrl: string | undefined, streamUrl: string): string {
  if (/^https?:\/\//i.test(streamUrl)) {
    return streamUrl
  }
  return `${apiBaseUrl?.replace(/\/+$/, "") ?? ""}${streamUrl}`
}

function resolveEventSource(ctor: EventSourceConstructor | undefined): EventSourceConstructor {
  if (ctor) {
    return ctor
  }

  const globalEventSource = (globalThis as unknown as { EventSource?: EventSourceConstructor }).EventSource
  if (!globalEventSource) {
    throw new Error("当前环境没有可用 EventSource。")
  }
  return globalEventSource
}

const SSE_EVENT_TYPES = [
  "turn_started",
  "text_delta",
  "text_done",
  "tool_call_start",
  "tool_call_args",
  "tool_call_end",
  "tool_result",
  "permission_request",
  "step_start",
  "step_progress",
  "step_end",
  "retrieval_start",
  "retrieval_delta",
  "retrieval_end",
  "compression_notify",
  "artifact_create",
  "artifact_delta",
  "artifact_finalize",
  "image",
  "stage_cue",
  "turn_completed",
  "error",
] as const
