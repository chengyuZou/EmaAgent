// 管理单个 Turn 的 SSE 重连、游标续传与业务终态。
import type { EmaStreamEvent } from '@ema-agent/contracts';
import {
  getSseOutcomeError,
  sseConsumer,
  type SseConnectionOutcome,
  type SseHandle,
  type SseStartOptions,
} from './sse-consumer.js';

const DEFAULT_MAX_RECONNECTS = 3;

export interface TurnSseLifecycleOptions {
  openResponse(signal: AbortSignal, lastEventId: number): Promise<Response>;
  initialCursor?: number;
  maxReconnects?: number;
  idleTimeoutMs?: number;
  reconnectDelayMs?(attempt: number): number;
  connect?(options: SseStartOptions): SseHandle;
  onEvent(event: EmaStreamEvent, cursor: number): void;
  onPermanentDisconnect(error: Error): void;
}

export interface TurnSseLifecycleHandle {
  readonly done: Promise<void>;
  stop(): void;
}

function isTurnTerminalEvent(event: EmaStreamEvent): boolean {
  return event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted';
}

function canReconnect(outcome: SseConnectionOutcome): boolean {
  return outcome.kind !== 'cancelled' && outcome.kind !== 'consumer_error';
}

export function startTurnSseLifecycle(
  options: TurnSseLifecycleOptions,
): TurnSseLifecycleHandle {
  const connect = options.connect ?? ((startOptions) => sseConsumer.start(startOptions));
  const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const reconnectDelayMs = options.reconnectDelayMs ?? ((attempt) => 1000 * 2 ** attempt);
  let cursor = options.initialCursor ?? 0;
  let activeConnection: SseHandle | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function finish(): void {
    if (finished) return;
    finished = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const connection = activeConnection;
    activeConnection = null;
    connection?.stop();
    resolveDone?.();
  }

  function failPermanently(outcome: SseConnectionOutcome): void {
    const error = getSseOutcomeError(outcome)
      ?? new Error('Turn SSE connection was cancelled unexpectedly');
    try {
      options.onPermanentDisconnect(error);
    } finally {
      finish();
    }
  }

  function beginConnection(attempt: number): void {
    if (finished) return;

    const connection = connect({
      lastEventId: cursor,
      idleTimeoutMs: options.idleTimeoutMs,
      requireEventId: true,
      openResponse: options.openResponse,
      onHeartbeat: () => {},
      onEvent(event, serverCursor) {
        if (serverCursor === undefined) {
          throw new Error('Turn SSE event has no server cursor');
        }
        cursor = serverCursor;
        options.onEvent(event, cursor);
        if (isTurnTerminalEvent(event)) finish();
      },
    });
    activeConnection = connection;

    void connection.done.then((outcome) => {
      if (finished || activeConnection !== connection) return;
      activeConnection = null;
      cursor = Math.max(cursor, outcome.lastEventId);

      if (outcome.kind === 'cancelled') {
        finish();
        return;
      }

      if (!canReconnect(outcome) || attempt >= maxReconnects) {
        failPermanently(outcome);
        return;
      }

      const delay = reconnectDelayMs(attempt);
      console.warn(
        `[turn-sse] connection ended; retry ${attempt + 1}/${maxReconnects} in ${delay}ms`,
        getSseOutcomeError(outcome)?.message,
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        beginConnection(attempt + 1);
      }, delay);
    });
  }

  beginConnection(0);

  return {
    done,
    stop: finish,
  };
}
