// 解析一条 SSE 响应，并返回唯一且结构化的连接终态。

export const SSE_IDLE_TIMEOUT_MS = 45_000;

/** 消费层对事件的最低结构要求：只保证判别字段存在，业务联合由调用方收窄。 */
export interface SseEventBase {
  readonly type: string;
}

export interface SseStartOptions<TEvent extends SseEventBase = SseEventBase> {
  signal?: AbortSignal;
  lastEventId?: number;
  idleTimeoutMs?: number;
  requireEventId?: boolean;
  openResponse(signal: AbortSignal, lastEventId: number): Promise<Response>;
  onEvent(event: TEvent, cursor?: number): void;
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
  start<TEvent extends SseEventBase = SseEventBase>(
    options: SseStartOptions<TEvent>,
  ): SseHandle;
} {
  return {
    start<TEvent extends SseEventBase = SseEventBase>(
      options: SseStartOptions<TEvent>,
    ) {
      const controller = new AbortController();
      const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
      let lastEventId = options.lastEventId ?? 0;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let readerCancel: Promise<void> | null = null;
      let requestedOutcome: SseConnectionOutcome | null = null;
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

      function cancelReader(reason: unknown): Promise<void> | null {
        if (!reader) return null;
        if (!readerCancel) {
          readerCancel = reader.cancel(reason).catch(() => undefined);
        }
        return readerCancel;
      }

      function requestTermination(outcome: SseConnectionOutcome): void {
        if (requestedOutcome || settled) return;
        requestedOutcome = outcome;
        if (!controller.signal.aborted) controller.abort();
        void cancelReader(outcome.kind);
      }

      function currentRequestedOutcome(): SseConnectionOutcome | null {
        return requestedOutcome;
      }

      function armIdleTimeout(): void {
        if (settled || requestedOutcome || idleTimeoutMs <= 0) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          requestTermination({
            kind: 'idle_timeout',
            lastEventId,
            error: new Error(`SSE connection silent for ${idleTimeoutMs}ms`),
          });
        }, idleTimeoutMs);
      }

      function onExternalAbort(): void {
        requestTermination({ kind: 'cancelled', lastEventId });
      }

      options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      if (options.signal?.aborted) onExternalAbort();
      armIdleTimeout();

      const parser = createFrameParser((frame) => {
        if (settled || requestedOutcome) return;
        const parsed = parseFrame(frame);
        if (!parsed) return;

        if (parsed.event === 'heartbeat') {
          options.onHeartbeat?.();
          return;
        }

        let event: TEvent;
        try {
          const decoded = JSON.parse(parsed.data) as Record<string, unknown>;
          if (typeof decoded.type !== 'string') {
            throw new Error('SSE event is missing a string type field');
          }
          if (options.requireEventId && parsed.cursor === undefined) {
            throw new Error('SSE event is missing a valid id field');
          }
          event = decoded as unknown as TEvent;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'invalid JSON event';
          requestTermination({
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
          requestTermination({
            kind: 'consumer_error',
            lastEventId,
            error: new Error(`SSE consumer error: ${message}`, { cause }),
          });
        }
      });

      void (async () => {
        try {
          const response = await options.openResponse(controller.signal, lastEventId);
          const outcomeAfterOpen = currentRequestedOutcome();
          if (outcomeAfterOpen) {
            await response.body?.cancel(outcomeAfterOpen.kind).catch(() => undefined);
            return;
          }

          if (!response.ok) {
            requestedOutcome = {
              kind: 'http_error',
              status: response.status,
              lastEventId,
              error: new Error(`SSE stream returned ${response.status}`),
            };
            return;
          }

          reader = response.body?.getReader() ?? null;
          if (!reader) {
            requestedOutcome = {
              kind: 'network_error',
              lastEventId,
              error: new Error('SSE response has no readable body'),
            };
            return;
          }

          armIdleTimeout();
          const decoder = new TextDecoder();
          while (!requestedOutcome) {
            const { done: readerDone, value } = await reader.read();
            if (readerDone) break;
            armIdleTimeout();
            parser.feed(decoder.decode(value, { stream: true }));
          }

          if (requestedOutcome) return;
          parser.feed(decoder.decode());
          parser.flush();
          if (!requestedOutcome) requestedOutcome = { kind: 'eof', lastEventId };
        } catch (cause) {
          if (!requestedOutcome) {
            const message = cause instanceof Error ? cause.message : 'unknown network error';
            requestedOutcome = {
              kind: 'network_error',
              lastEventId,
              error: new Error(message, { cause }),
            };
          }
        } finally {
          const outcome = requestedOutcome ?? { kind: 'eof' as const, lastEventId };
          await cancelReader(outcome.kind);
          settle(outcome);
        }
      })();

      return {
        done,
        stop() {
          requestTermination({ kind: 'cancelled', lastEventId });
        },
      };
    },
  };
}

export const sseConsumer = createSseConsumer();
