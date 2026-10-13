import type { AppEvent } from '@ema-agent/server/application/appEvents.js';

export const SSE_IDLE_TIMEOUT_MS = 45_000;

export interface SseStartOptions {
  openResponse(signal: AbortSignal): Promise<Response>;
  onEvent(event: AppEvent): void;
}

// 系统事件没有 id 或重放接口. 重连只接收新事件, 不维护未被后端支持的恢复游标.
export type SseConnectionOutcome =
  | { kind: 'eof' }
  | { kind: 'cancelled' }
  | { kind: 'idle_timeout'; error: Error }
  | { kind: 'http_error'; status: number; error: Error }
  | { kind: 'network_error'; error: Error }
  | { kind: 'protocol_error'; error: Error }
  | { kind: 'consumer_error'; error: Error };

export interface SseHandle {
  readonly done: Promise<SseConnectionOutcome>;
  stop(): void;
}

export function getSseOutcomeError(outcome: SseConnectionOutcome): Error | null {
  if (outcome.kind === 'cancelled') {
    return null;
  }
  if (outcome.kind === 'eof') {
    return new Error('System event stream ended');
  }
  return outcome.error;
}

interface ParsedFrame {
  event?: string;
  data: string;
}

function createFrameParser(onFrame: (frame: string) => void): {
  feed(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf('\n\n');
        if (index === -1) {
          break;
        }
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.trim()) {
          onFrame(frame);
        }
      }
    },
    flush() {
      if (!buffer.trim()) {
        return;
      }
      const remaining = buffer;
      buffer = '';
      onFrame(remaining);
    },
  };
}

function parseFrame(frame: string): ParsedFrame | null {
  let event: string | undefined;
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
  }
  if (!data) {
    return null;
  }
  return { event: event || undefined, data };
}

/** 消费一个系统事件响应. stop 会取消请求和响应读取, done 在清理完成后返回结束原因. */
export function startSseConsumer(options: SseStartOptions): SseHandle {
  const controller = new AbortController();
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let readerCancel: Promise<void> | null = null;
  let requestedOutcome: SseConnectionOutcome | null = null;
  let resolveDone: (outcome: SseConnectionOutcome) => void;
  const done = new Promise<SseConnectionOutcome>(resolve => {
    resolveDone = resolve;
  });

  function cancelReader(reason: string): Promise<void> | null {
    if (!reader) {
      return null;
    }
    if (!readerCancel) {
      readerCancel = reader.cancel(reason).catch(() => undefined);
    }
    return readerCancel;
  }

  function requestTermination(outcome: SseConnectionOutcome): void {
    if (requestedOutcome || settled) {
      return;
    }
    requestedOutcome = outcome;
    controller.abort();
    void cancelReader(outcome.kind);
  }

  function armIdleTimeout(): void {
    if (settled || requestedOutcome) {
      return;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      requestTermination({
        kind: 'idle_timeout',
        error: new Error(`SSE connection silent for ${SSE_IDLE_TIMEOUT_MS}ms`),
      });
    }, SSE_IDLE_TIMEOUT_MS);
  }

  const parser = createFrameParser(frame => {
    if (settled || requestedOutcome) {
      return;
    }
    const parsed = parseFrame(frame);
    if (!parsed || parsed.event === 'heartbeat') {
      return;
    }

    let event: AppEvent;
    try {
      const decoded = JSON.parse(parsed.data) as { type?: unknown };
      if (typeof decoded.type !== 'string') {
        throw new Error('SSE event is missing a string type field');
      }
      event = decoded as AppEvent;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'invalid JSON event';
      requestTermination({
        kind: 'protocol_error',
        error: new Error(`SSE protocol error: ${message}`, { cause }),
      });
      return;
    }
    try {
      options.onEvent(event);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'event consumer failed';
      requestTermination({
        kind: 'consumer_error',
        error: new Error(`SSE consumer error: ${message}`, { cause }),
      });
    }
  });

  armIdleTimeout();
  function currentRequestedOutcome(): SseConnectionOutcome | null {
    return requestedOutcome;
  }
  void (async () => {
    try {
      const response = await options.openResponse(controller.signal);
      const outcomeAfterOpen = currentRequestedOutcome();
      if (outcomeAfterOpen) {
        // 请求取消后仍可能收到响应; 不能把这份响应留在后台继续读取.
        await response.body?.cancel(outcomeAfterOpen.kind).catch(() => undefined);
        return;
      }
      if (!response.ok) {
        requestedOutcome = {
          kind: 'http_error',
          status: response.status,
          error: new Error(`SSE stream returned ${response.status}`),
        };
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      reader = response.body?.getReader() ?? null;
      if (!reader) {
        requestedOutcome = {
          kind: 'network_error',
          error: new Error('SSE response has no readable body'),
        };
        return;
      }
      armIdleTimeout();
      const decoder = new TextDecoder();
      while (!requestedOutcome) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) {
          break;
        }
        // 心跳与业务事件都重置计时. 心跳只证明连接仍活着, 不交给业务监听者.
        armIdleTimeout();
        parser.feed(decoder.decode(value, { stream: true }));
      }
      if (!requestedOutcome) {
        parser.feed(decoder.decode());
        parser.flush();
      }
    } catch (cause) {
      if (!requestedOutcome) {
        const message = cause instanceof Error ? cause.message : 'unknown network error';
        requestedOutcome = {
          kind: 'network_error',
          error: new Error(message, { cause }),
        };
      }
    } finally {
      const outcome = requestedOutcome ?? { kind: 'eof' };
      await cancelReader(outcome.kind);
      settled = true;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }
      resolveDone!(outcome);
    }
  })();

  return {
    done,
    stop() {
      requestTermination({ kind: 'cancelled' });
    },
  };
}
