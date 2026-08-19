// Turn 的有界重放日志：SSE 断线重连恢复用；不拥有 Turn 生命周期。
import type { PublishedTurnEvent, TurnWireEvent } from './eventHub.js';

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
  | { status: 'overflow' }
  | { status: 'closed' };

/**
 * 活跃 Turn 超过内存预算时拒绝继续写入（调用方负责终止该 Turn）；终态事件仍保留，
 * 让已经收到前缀的客户端可以明确结束，而不是永久等待。
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

  push(turnId: string, event: TurnWireEvent): TurnEventPushResult {
    const entry = this.getOrCreate(turnId);
    if (entry.done) return { status: 'closed' };

    const terminal = isTerminalWireEvent(event);
    if (entry.overflowed && !terminal) return { status: 'overflow' };

    // 在线订阅者收到原始音频；重放日志从一开始就去掉 base64，避免一句 TTS
    // 同时占据归档缓冲、SSE 重放和浏览器三份内存。
    const replayEvent = eventForReplay(event);
    const bytes = Buffer.byteLength(JSON.stringify(replayEvent), 'utf8');
    if (!terminal && (
      entry.bytes + bytes > this.maxBytesPerTurn ||
      this.totalBytes + bytes > this.maxBytesTotal
    )) {
      entry.overflowed = true;
      return { status: 'overflow' };
    }

    const published: PublishedTurnEvent = { cursor: entry.nextCursor++, event: replayEvent };
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

function isTerminalWireEvent(event: TurnWireEvent): boolean {
  return event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted';
}

function eventForReplay(event: TurnWireEvent): TurnWireEvent {
  if (event.type !== 'tts_chunk') return event;
  return { ...event, audio: '' };
}
