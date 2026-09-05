// Vision 文本描述缓存:以图片受管副本 path 为键, 同键并发只生产一次;
// TTL 与容量预算的清扫也归这个类(生产与清扫是一件事的两半)。

import type {
  AttachmentVisionDescriptionCachesRepo,
} from '@ema-agent/storage';

const DEFAULT_MEMORY_ENTRIES = 256;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DELETE_BATCH_SIZE = 128;

/** 生产者由调用方注入:拿图片 path 读字节调 Vision 模型, 返回描述正文;
 *  signal 透传给底层视觉调用, Turn 取消可中断生产。 */
export type VisionDescriptionProducer = (
  imagePath: string,
  signal: AbortSignal,
) => Promise<string>;

export class VisionDescriptionCache {
  /** 同键正在生产的 Promise:并发调用共享一次付费生产。 */
  private readonly inFlight = new Map<string, Promise<string>>();
  /** 内存 LRU:delete+set 即刷新热度;淘汰最久未命中者。 */
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly repo: AttachmentVisionDescriptionCachesRepo,
    private readonly maxMemoryEntries = DEFAULT_MEMORY_ENTRIES,
  ) {}

  async getOrCreate(
    imagePath: string,
    signal: AbortSignal,
    produce: VisionDescriptionProducer,
  ): Promise<string> {
    const key = imagePath;

    const memoryHit = this.memory.get(key);
    if (memoryHit !== undefined) {
      this.memory.delete(key);
      this.memory.set(key, memoryHit);
      return memoryHit;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = this.loadOrCreate(key, imagePath, signal, produce);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  clearMemory(): void {
    this.memory.clear();
  }

  /**
   * 空闲清扫:TTL 过期整批删, 仍超容量预算则从最久未访问开始驱逐。
   * 节奏状态(上次清扫时间)由本类自持;失败允许下个后台周期重试。
   */
  async sweepIfIdle(
    options: VisionDescriptionCacheSweepOptions,
    now = Date.now(),
  ): Promise<VisionDescriptionCacheSweepReport> {
    if (!options.isIdle() || now - this.lastSweepAt < DEFAULT_MIN_INTERVAL_MS) {
      return { ran: false, deletedDescriptions: 0, freedBytes: 0 };
    }

    let deleted = 0;
    let freed = 0;
    const cutoff = now - DEFAULT_TTL_MS;

    for (;;) {
      const expired = this.repo.listAccessedBefore(cutoff, DELETE_BATCH_SIZE);
      if (expired.length === 0) break;
      freed += sumBytes(expired);
      deleted += this.repo.deleteRows(expired.map((row) => row.path));
      if (expired.length < DELETE_BATCH_SIZE) break;
    }

    const maxBytes = options.maxBytesForSweep();
    let currentTotalBytes = this.repo.totalBytes();
    while (currentTotalBytes > maxBytes) {
      const oldest = this.repo.listOldest(DELETE_BATCH_SIZE);
      if (oldest.length === 0) break;
      for (const row of oldest) {
        freed += row.byte_size;
        deleted += this.repo.deleteRows([row.path]);
        currentTotalBytes -= row.byte_size;
        if (currentTotalBytes <= maxBytes) break;
      }
    }

    this.lastSweepAt = now;
    return { ran: true, deletedDescriptions: deleted, freedBytes: freed };
  }

  private lastSweepAt = 0;

  private async loadOrCreate(
    key: string,
    imagePath: string,
    signal: AbortSignal,
    produce: VisionDescriptionProducer,
  ): Promise<string> {
    const persisted = this.repo.find(imagePath);
    if (persisted) {
      this.repo.touch(imagePath, Date.now());
      this.putMemory(key, persisted.text);
      return persisted.text;
    }

    signal.throwIfAborted();
    const text = (await produce(imagePath, signal)).trim();
    signal.throwIfAborted();
    if (!text) throw new Error('Vision 没有返回可缓存的图片描述');

    this.repo.upsert(imagePath, text, Buffer.byteLength(text, 'utf8'), Date.now());
    this.putMemory(key, text);
    return text;
  }

  private putMemory(key: string, text: string): void {
    this.memory.delete(key);
    this.memory.set(key, text);
    while (this.memory.size > this.maxMemoryEntries) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }
}

export interface VisionDescriptionCacheSweepOptions {
  readonly isIdle: () => boolean;
  /** 每次真正清理时读取一次;运行中的清理不被设置变更打断。 */
  readonly maxBytesForSweep: () => number;
}

export interface VisionDescriptionCacheSweepReport {
  readonly ran: boolean;
  readonly deletedDescriptions: number;
  readonly freedBytes: number;
}

function sumBytes(rows: readonly { byte_size: number }[]): number {
  return rows.reduce((sum, row) => sum + row.byte_size, 0);
}
