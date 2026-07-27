// 保存 Turn 的有界 SSE 重放日志，并为每条事件分配稳定游标。

import type { TurnId } from '@ema-agent/ids';
import type { TurnStreamEvent } from '@ema-agent/events';
import type { PublishedTurnEvent } from './event-hub.js';

const DEFAULT_TURN_BUDGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_TOTAL_BUDGET_BYTES = 64 * 1024 * 1024;

export interface TurnEventStoreOptions {
  ttlMs?: number;
  maxBytesPerTurn?: number;
  maxBytesTotal?: number;
}

export type TurnEventPushResult =
  | { status: 'stored'; published: PublishedTurnEvent }
  | { status: 'overflow' }
  | { status: 'closed' };

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

/**
 * 重放日志只负责短时断线恢复，不拥有 Turn 生命周期。
 *
 * 活跃 Turn 超过内存预算时拒绝继续写入，由调用方终止该 Turn；终态事件仍保留，
 * 让已经收到前缀的客户端可以明确结束，而不是永久等待。
 */
export class TurnEventStore {
  private readonly store = new Map<string, TurnEventEntry>();
  private readonly ttlMs: number;
  private readonly maxBytesPerTurn: number;
  private readonly maxBytesTotal: number;
  private totalBytes = 0;

  constructor(options: TurnEventStoreOptions | number = {}) {
    const resolved = typeof options === 'number' ? { ttlMs: options } : options;
    this.ttlMs = positiveInteger(resolved.ttlMs, 60_000);
    this.maxBytesPerTurn = positiveInteger(
      resolved.maxBytesPerTurn,
      DEFAULT_TURN_BUDGET_BYTES,
    );
    this.maxBytesTotal = positiveInteger(
      resolved.maxBytesTotal,
      DEFAULT_TOTAL_BUDGET_BYTES,
    );
  }

  push(turnId: TurnId, event: TurnStreamEvent): TurnEventPushResult {
    const key = turnId as string;
    const entry = this.getOrCreate(key);
    if (entry.done) return { status: 'closed' };

    const terminal = isTerminalTurnEvent(event);
    if (entry.overflowed && !terminal) return { status: 'overflow' };

    // 在线订阅者收到原始音频；重放日志从一开始就去掉 base64，避免一句 TTS
    // 同时占据归档缓冲、SSE 重放和浏览器三份内存。
    const replayEvent = eventForReplay(event);
    const bytes = eventBytes(replayEvent);
    if (!terminal && (
      entry.bytes + bytes > this.maxBytesPerTurn ||
      this.totalBytes + bytes > this.maxBytesTotal
    )) {
      entry.overflowed = true;
      return { status: 'overflow' };
    }

    const published: PublishedTurnEvent = {
      cursor: entry.nextCursor++,
      event: replayEvent,
    };
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
  replay(turnId: TurnId, sinceCursor: number): PublishedTurnEvent[] {
    const entry = this.store.get(turnId as string);
    if (!entry) return [];
    return entry.events
      .filter(item => item.cursor > sinceCursor)
      .map(({ cursor, event }) => ({ cursor, event }));
  }

  isDone(turnId: TurnId): boolean {
    return this.store.get(turnId as string)?.done ?? false;
  }

  /** 定期释放已经完成且超过重连窗口的 Turn。 */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.done && entry.doneAt !== undefined && now - entry.doneAt > this.ttlMs) {
        this.deleteEntry(key, entry);
      }
    }
  }

  clear(turnId: TurnId): void {
    const key = turnId as string;
    const entry = this.store.get(key);
    if (entry) this.deleteEntry(key, entry);
  }

  /**
   * 兼容旧调用：已写入的音频事件再次做脱敏，并重新核算内存预算。
   * 新事件在 push 时已经脱敏，因此正常情况下该方法不会改变字节数。
   */
  evictAudioChunks(turnId: TurnId): void {
    const entry = this.store.get(turnId as string);
    if (!entry) return;

    let nextBytes = 0;
    entry.events = entry.events.map((item) => {
      const event = eventForReplay(item.event);
      const bytes = eventBytes(event);
      nextBytes += bytes;
      return { cursor: item.cursor, event, bytes };
    });
    this.totalBytes += nextBytes - entry.bytes;
    entry.bytes = nextBytes;
  }

  private getOrCreate(key: string): TurnEventEntry {
    const existing = this.store.get(key);
    if (existing) return existing;
    const created: TurnEventEntry = {
      events: [],
      nextCursor: 1,
      bytes: 0,
      done: false,
      overflowed: false,
    };
    this.store.set(key, created);
    return created;
  }

  private deleteEntry(key: string, entry: TurnEventEntry): void {
    this.store.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function isTerminalTurnEvent(event: TurnStreamEvent): boolean {
  return event.type === 'turn_completed' ||
    event.type === 'turn_failed' ||
    event.type === 'turn_aborted';
}

function eventForReplay(event: TurnStreamEvent): TurnStreamEvent {
  if (event.type !== 'tts_chunk') return event;
  return { ...event, audio: '', lipsync: undefined };
}

function eventBytes(event: TurnStreamEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}
