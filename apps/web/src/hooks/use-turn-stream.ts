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
 * 前端 turn stream hook 骨架。
 *
 * 真实实现后续再处理 EventSource、事件合并、文本拼接和错误状态。
 */
export function useTurnStream(options: UseTurnStreamOptions = {}): TurnStreamController {
  void options

  const state = createInitialState()

  return {
    getState: () => state,
    subscribe(listener) {
      void listener
      return () => {}
    },
    start(response) {
      void response
    },
    connect(streamUrl, requestId) {
      void streamUrl
      void requestId
    },
    close() {},
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
  void state
  return ""
}
