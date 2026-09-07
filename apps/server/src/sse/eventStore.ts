// Turn 的有界重放日志：SSE 断线重连恢复用；不拥有 Turn 生命周期。
import type { PublishedTurnEvent, TurnSseEvent } from './eventHub.js';

const DEFAULT_TURN_BUDGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_TOTAL_BUDGET_BYTES = 64 * 1024 * 1024;
/** 终态后保留时长：超过重连窗口即释放。 */
const DEFAULT_TTL_MS = 60_000;

interface StoredTurnEvent extends PublishedTurnEvent {
  bytes: number;
}

interface TurnEventEntry {
  events: StoredTurnEvent[];
  nextCursor: number;
  bytes: number;
  done: boolean;
  doneAt?: number;
  overflowed: boolean;
}

export type TurnEventPushResult =
  | { status: 'stored'; published: PublishedTurnEvent }
  | { status: 'live_only'; published: PublishedTurnEvent }
  | { status: 'closed' };

/**
 * 超过重放预算后停止缓存后续非终态事件，但在线流继续，Turn 生命周期不归缓存所有。
 */
export class TurnEventStore {
  private readonly store = new Map<string, TurnEventEntry>();
  private readonly ttlMs: number;
  private readonly maxBytesPerTurn: number;
  private readonly maxBytesTotal: number;
  private totalBytes = 0;

  constructor(options: { ttlMs?: number; maxBytesPerTurn?: number; maxBytesTotal?: number } = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    this.maxBytesPerTurn = positiveInteger(options.maxBytesPerTurn, DEFAULT_TURN_BUDGET_BYTES);
    this.maxBytesTotal = positiveInteger(options.maxBytesTotal, DEFAULT_TOTAL_BUDGET_BYTES);
  }

  /** 创建 Turn 后立即登记空日志，避免订阅请求与首事件之间出现身份竞态。 */
  open(turnId: string): void {
    this.getOrCreate(turnId);
  }

  /** 判断 Turn 是否仍处于本进程允许重连的窗口内。 */
  has(turnId: string): boolean {
    return this.store.has(turnId);
  }

  push(turnId: string, event: TurnSseEvent): TurnEventPushResult {
    const entry = this.getOrCreate(turnId);
    if (entry.done) return { status: 'closed' };

    const terminal = isTerminalSseEvent(event);
    const published: PublishedTurnEvent = { cursor: entry.nextCursor++, event };
    if (entry.overflowed && !terminal) return { status: 'live_only', published };

    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (!terminal && (
      entry.bytes + bytes > this.maxBytesPerTurn ||
      this.totalBytes + bytes > this.maxBytesTotal
    )) {
      entry.overflowed = true;
      return { status: 'live_only', published };
    }

    entry.events.push({ ...published, bytes });
    entry.bytes += bytes;
    this.totalBytes += bytes;

    if (terminal) {
      entry.done = true;
      entry.doneAt = Date.now();
    }
    return { status: 'stored', published };
  }

  /** 返回 cursor 严格大于 sinceCursor 的事件。 */
  replay(turnId: string, sinceCursor: number): PublishedTurnEvent[] {
    const entry = this.store.get(turnId);
    if (!entry) return [];
    return entry.events
      .filter(item => item.cursor > sinceCursor)
      .map(({ cursor, event }) => ({ cursor, event }));
  }

  isDone(turnId: string): boolean {
    return this.store.get(turnId)?.done ?? false;
  }

  /** 定期释放已经完成且超过重连窗口的 Turn。 */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.done && entry.doneAt !== undefined && now - entry.doneAt > this.ttlMs) {
        this.store.delete(key);
        this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      }
    }
  }

  clear(turnId: string): void {
    const entry = this.store.get(turnId);
    if (!entry) return;
    this.store.delete(turnId);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }

  private getOrCreate(turnId: string): TurnEventEntry {
    const existing = this.store.get(turnId);
    if (existing) return existing;
    const created: TurnEventEntry = {
      events: [],
      nextCursor: 1,
      bytes: 0,
      done: false,
      overflowed: false,
    };
    this.store.set(turnId, created);
    return created;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isTerminalSseEvent(event: TurnSseEvent): boolean {
  return event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted';
}
