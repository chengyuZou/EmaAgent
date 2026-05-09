import type { EmaStreamEvent } from '@ema-agent/contracts';

/** Encode one EmaStreamEvent as an SSE data line. Handles tts_chunk base64. */
export function encodeEvent(event: EmaStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function encodePing(): string {
  return 'event: heartbeat\ndata: {}\n\n';
}

/**
 * Returns an async generator that wraps an AsyncIterable<EmaStreamEvent>
 * into raw SSE strings, injecting a heartbeat every `intervalMs` ms.
 */
export async function* sseStream(
  events: AsyncIterable<EmaStreamEvent>,
  intervalMs = 15_000,
): AsyncGenerator<string> {
  let lastPing = Date.now();

  for await (const event of events) {
    const now = Date.now();
    if (now - lastPing >= intervalMs) {
      yield encodePing();
      lastPing = now;
    }
    yield encodeEvent(event);
  }
}
