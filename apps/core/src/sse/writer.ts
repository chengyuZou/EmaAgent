import type { EmaStreamEvent } from '@ema-agent/contracts';

/** Encode one EmaStreamEvent as an SSE data line. */
export function encodeEvent(event: EmaStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Encode a keep-alive heartbeat as a raw SSE event.
 * Note: this is intentionally NOT an EmaStreamEvent — it bypasses the event
 * store entirely and is written directly to the ReadableStream by the GET
 * handler's setInterval. The frontend should listen on the `heartbeat` SSE
 * event name, not parse it as JSON.
 */
export function encodePing(): string {
  return 'event: heartbeat\ndata: {}\n\n';
}
