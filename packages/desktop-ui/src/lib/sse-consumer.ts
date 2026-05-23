/**
 * SSE / fetch-stream consumer — parse `text/event-stream` from a sidecar
 * response using fetch + ReadableStream (NOT EventSource, because we need
 * custom headers + Last-Event-ID).
 */
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SseStartOptions {
  url:           string;
  signal?:       AbortSignal;
  lastEventId?:  number;
  onEvent:       (event: EmaStreamEvent) => void;
  onHeartbeat?:  () => void;
  onError?:      (err: Error) => void;
  onComplete?:   () => void;
}

export interface SseHandle {
  stop(): void;
}

// ── SSE frame parser ──────────────────────────────────────────────────────────

/**
 * Minimal state machine that accumulates a text stream and emits complete
 * SSE frames (delimited by `\n\n`).
 */
function createFrameParser(onFrame: (frame: string) => void) {
  let buffer = '';

  return {
    feed(chunk: string): void {
      buffer += chunk;
      // Split on \n\n (SSE frame delimiter)
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) {
          onFrame(frame);
        }
      }
    },
    /** Flush remaining buffer as a partial frame (should not happen). */
    flush(): void {
      if (buffer.trim()) {
        onFrame(buffer);
        buffer = '';
      }
    },
  };
}

/**
 * Parse a single SSE frame into event name + data string.
 * Format:
 *   event: heartbeat
 *   data: {"type":"..."}
 */
function parseFrame(frame: string): { event?: string; data: string } | null {
  let event: string | undefined;
  let data = '';

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data = line.slice(5).trim();
    }
  }

  if (!data) return null;
  return { event: event || undefined, data };
}

// ── Consumer ──────────────────────────────────────────────────────────────────

export function createSseConsumer(): {
  start(opts: SseStartOptions): SseHandle;
} {
  return {
    start(opts: SseStartOptions): SseHandle {
      const controller = new AbortController();
      let stopped = false;

      // Merge external signal
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          controller.abort();
        }, { once: true });
      }

      const parser = createFrameParser((frame) => {
        const parsed = parseFrame(frame);
        if (!parsed) return;

        // Heartbeat
        if (parsed.event === 'heartbeat') {
          opts.onHeartbeat?.();
          return;
        }

        // Parse JSON event
        try {
          const obj = JSON.parse(parsed.data) as Record<string, unknown>;
          if (typeof obj.type === 'string') {
            opts.onEvent(obj as unknown as EmaStreamEvent);
          } else {
            console.warn('[sse] event missing "type" field, skipping', obj);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'parse error';
          opts.onError?.(new Error(`SSE parse error: ${message}`));
          // Continue — don't break the stream on one bad frame
        }
      });

      // Start fetch
      void (async () => {
        try {
          const res = await fetch(opts.url, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });

          if (!res.ok) {
            opts.onError?.(new Error(`SSE stream returned ${res.status}`));
            return;
          }

          const reader = res.body?.getReader();
          if (!reader) {
            opts.onError?.(new Error('No readable stream body'));
            return;
          }

          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
          }

          parser.flush();
          if (!stopped) {
            opts.onComplete?.();
          }
        } catch (err: unknown) {
          if (controller.signal.aborted) return; // expected
          const message = err instanceof Error ? err.message : 'Unknown SSE error';
          opts.onError?.(new Error(message));
        }
      })();

      return {
        stop() {
          stopped = true;
          controller.abort();
        },
      };
    },
  };
}

/** Shared singleton — one SSE consumer for the whole app. */
export const sseConsumer = createSseConsumer();
