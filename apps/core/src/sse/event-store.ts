import type { EmaStreamEvent, TurnId } from '@ema-agent/contracts';

/**
 * In-memory store for SSE events keyed by turnId.
 * Allows reconnecting clients to replay missed events via ?lastEventId.
 *
 * Events are evicted after the turn reaches a terminal state
 * (turn_completed / turn_failed / turn_aborted) + a short TTL.
 */
export class TurnEventStore {
  private readonly store = new Map<string, { events: EmaStreamEvent[]; done: boolean; doneAt?: number }>();
  private readonly cancelled = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  push(turnId: TurnId, event: EmaStreamEvent): void {
    const key = turnId as string;
    if (this.cancelled.has(key)) return;
    if (!this.store.has(key)) {
      this.store.set(key, { events: [], done: false });
    }
    const entry = this.store.get(key)!;
    entry.events.push(event);

    if (
      event.type === 'turn_completed' ||
      event.type === 'turn_failed' ||
      event.type === 'turn_aborted'
    ) {
      entry.done = true;
      entry.doneAt = Date.now();
    }
  }

  /** Returns events after `sinceIndex` (0-based). Used for reconnect replay. */
  replay(turnId: TurnId, sinceIndex: number): EmaStreamEvent[] {
    const entry = this.store.get(turnId as string);
    if (!entry) return [];
    return entry.events.slice(sinceIndex);
  }

  isDone(turnId: TurnId): boolean {
    return this.store.get(turnId as string)?.done ?? false;
  }

  /** Call periodically to free memory from completed turns. */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.done && entry.doneAt !== undefined && now - entry.doneAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
    for (const [key, cancelledAt] of this.cancelled.entries()) {
      if (now - cancelledAt > this.ttlMs) {
        this.cancelled.delete(key);
      }
    }
  }


  cancel(turnId: TurnId): void {
    const key = turnId as string;
    this.cancelled.set(key, Date.now());
    this.store.delete(key);
  }

  clear(turnId: TurnId): void {
    const key = turnId as string;
    this.cancelled.delete(key);
    this.store.delete(key);
  }

  /**
   * Drop all `tts_chunk` events for a turn while keeping every other event
   * (sentence boundaries, text deltas, lifecycle). Called by the TtsCoordinator
   * after `archive.finalizeTurn()` writes a merged audio file — at that point
   * the streamed audio is reconstructable from the file via the audio route,
   * so holding hundreds of KB of base64 in memory for SSE replay is wasteful.
   *
   * Reconnecting clients can still see which sentences played
   * (`tts_sentence_complete`) and fetch the full merged audio via
   * `GET /api/turns/:turnId/audio` for replay.
   */
  evictAudioChunks(turnId: TurnId): void {
    const entry = this.store.get(turnId as string);
    if (!entry) return;
    entry.events = entry.events.filter((e) => e.type !== 'tts_chunk');
  }
}
