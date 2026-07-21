// 解析一条 SSE 响应，并返回唯一且结构化的连接终态。
import type { EmaStreamEvent } from '@ema-agent/turn';

export const SSE_IDLE_TIMEOUT_MS = 45_000;

export interface SseStartOptions {
  signal?: AbortSignal;
  lastEventId?: number;
  idleTimeoutMs?: number;
  requireEventId?: boolean;
  openResponse(signal: AbortSignal, lastEventId: number): Promise<Response>;
  onEvent(event: EmaStreamEvent, cursor?: number): void;
  onHeartbeat?(): void;
}

interface SseOutcomeBase {
  lastEventId: number;
}

export type SseConnectionOutcome =
  | (SseOutcomeBase & { kind: 'eof' })
  | (SseOutcomeBase & { kind: 'cancelled' })
  | (SseOutcomeBase & { kind: 'idle_timeout'; error: Error })
  | (SseOutcomeBase & { kind: 'http_error'; status: number; error: Error })
  | (SseOutcomeBase & { kind: 'network_error'; error: Error })
  | (SseOutcomeBase & { kind: 'protocol_error'; error: Error })
  | (SseOutcomeBase & { kind: 'consumer_error'; error: Error });

export interface SseHandle {
  readonly done: Promise<SseConnectionOutcome>;
  stop(): void;
}

export function getSseOutcomeError(outcome: SseConnectionOutcome): Error | null {
  if (outcome.kind === 'cancelled') return null;
  if (outcome.kind === 'eof') {
    return new Error('SSE connection ended before a business terminal event');
  }
  return outcome.error;
}

interface ParsedFrame {
  event?: string;
  data: string;
  cursor?: number;
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
        if (index === -1) break;
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.trim()) onFrame(frame);
      }
    },
    flush() {
      if (!buffer.trim()) return;
      const remaining = buffer;
      buffer = '';
      onFrame(remaining);
    },
  };
}

function parseFrame(frame: string): ParsedFrame | null {
  let event: string | undefined;
  let data = '';
  let cursor: number | undefined;

  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) {
      const parsed = Number.parseInt(line.slice(3).trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) cursor = parsed;
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
  }

  if (!data) return null;
  return { event: event || undefined, data, cursor };
}

export function createSseConsumer(): {
  start(options: SseStartOptions): SseHandle;
} {
  return {
    start(options) {
      const controller = new AbortController();
      const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
      let lastEventId = options.lastEventId ?? 0;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let resolveDone: ((outcome: SseConnectionOutcome) => void) | undefined;
      const done = new Promise<SseConnectionOutcome>((resolve) => {
        resolveDone = resolve;
      });

      function cleanup(): void {
        if (idleTimer !== null) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        options.signal?.removeEventListener('abort', onExternalAbort);
      }

      function settle(outcome: SseConnectionOutcome): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolveDone?.(outcome);
      }

      function terminate(outcome: SseConnectionOutcome): void {
        settle(outcome);
        if (!controller.signal.aborted) controller.abort();
      }

      function armIdleTimeout(): void {
        if (settled || idleTimeoutMs <= 0) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          terminate({
            kind: 'idle_timeout',
            lastEventId,
            error: new Error(`SSE connection silent for ${idleTimeoutMs}ms`),
          });
        }, idleTimeoutMs);
      }

      function onExternalAbort(): void {
        terminate({ kind: 'cancelled', lastEventId });
      }

      options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      if (options.signal?.aborted) onExternalAbort();
      armIdleTimeout();

      const parser = createFrameParser((frame) => {
        if (settled) return;
        const parsed = parseFrame(frame);
        if (!parsed) return;

        if (parsed.event === 'heartbeat') {
          options.onHeartbeat?.();
          return;
        }

        let event: EmaStreamEvent;
        try {
          const decoded = JSON.parse(parsed.data) as Record<string, unknown>;
          if (typeof decoded.type !== 'string') {
            throw new Error('SSE event is missing a string type field');
          }
          if (options.requireEventId && parsed.cursor === undefined) {
            throw new Error('SSE event is missing a valid id field');
          }
          event = decoded as unknown as EmaStreamEvent;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'invalid JSON event';
          terminate({
            kind: 'protocol_error',
            lastEventId,
            error: new Error(`SSE protocol error: ${message}`, { cause }),
          });
          return;
        }

        try {
          options.onEvent(event, parsed.cursor);
          if (parsed.cursor !== undefined) lastEventId = parsed.cursor;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'event consumer failed';
          terminate({
            kind: 'consumer_error',
            lastEventId,
            error: new Error(`SSE consumer error: ${message}`, { cause }),
          });
        }
      });

      void (async () => {
        try {
          const response = await options.openResponse(controller.signal, lastEventId);
          if (settled) return;

          if (!response.ok) {
            settle({
              kind: 'http_error',
              status: response.status,
              lastEventId,
              error: new Error(`SSE stream returned ${response.status}`),
            });
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            settle({
              kind: 'network_error',
              lastEventId,
              error: new Error('SSE response has no readable body'),
            });
            return;
          }

          const decoder = new TextDecoder();
          while (!settled) {
            const { done: readerDone, value } = await reader.read();
            if (readerDone) break;
            armIdleTimeout();
            parser.feed(decoder.decode(value, { stream: true }));
          }

          if (settled) return;
          parser.feed(decoder.decode());
          parser.flush();
          if (!settled) settle({ kind: 'eof', lastEventId });
        } catch (cause) {
          if (settled) return;
          const message = cause instanceof Error ? cause.message : 'unknown network error';
          settle({
            kind: 'network_error',
            lastEventId,
            error: new Error(message, { cause }),
          });
        }
      })();

      return {
        done,
        stop() {
          terminate({ kind: 'cancelled', lastEventId });
        },
      };
    },
  };
}

export const sseConsumer = createSseConsumer();
