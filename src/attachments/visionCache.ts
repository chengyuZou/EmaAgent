// Vision 文本描述缓存:以图片受管副本 path 为键, 同键并发只生产一次;

import type {
  AttachmentVisionDescriptionCachesRepo,
} from '@ema-agent/storage';

const DEFAULT_MEMORY_ENTRIES = 256;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DELETE_BATCH_SIZE = 128;

/**
 * @param imagePath 图片绝对路径
 * @returns 该图片的文本描述
 */
export type VisionDescriptionProducer = (
  imagePath: string,
  signal: AbortSignal,
) => Promise<string>;

export class VisionDescriptionCache {
  /**
   * 同键正在生产的 Promise
   * 例如: A,B,C 三个请求同时请求同一张图片的描述, 只会触发一次 Vision 调用,
   * 其余两个请求共享同一个 Promise 从而避免重复调用 Vision.
   */
  private readonly inFlight = new Map<string, Promise<string>>();
  /**
   * 内存 LRU:delete+set 即刷新热度; 淘汰最久未命中者.
   * Key: 图片绝对路径
   * Value: Vision 文本描述
   */
  private readonly cache = new Map<string, string>();
  private lastSweepAt = 0;

  constructor(
    private readonly repo: AttachmentVisionDescriptionCachesRepo,
    private readonly maxMemoryEntries = DEFAULT_MEMORY_ENTRIES,
  ) {}

  async getOrCreate(
    imagePath: string,
    signal: AbortSignal,
    produce: VisionDescriptionProducer,
  ): Promise<string> {
    const memoryHit = this.cache.get(imagePath);
    if (memoryHit !== undefined) {
      this.cache.delete(imagePath);
      this.cache.set(imagePath, memoryHit);
      return memoryHit;
    }

    const existing = this.inFlight.get(imagePath);
    if (existing) return existing;

    const operation = this.loadOrCreate(imagePath, signal, produce);
    this.inFlight.set(imagePath, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(imagePath) === operation) this.inFlight.delete(imagePath);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 系统空闲时 清理 Repo 库中过期的 Vision 描述缓存
   * 并在必要时清理 Repo 库中超过最大字节数的最旧缓存.
   */
  async sweepIfIdle(
    options: VisionDescriptionCacheSweepOptions,
    now = Date.now(),
  ): Promise<VisionDescriptionCacheSweepReport> {
    if (!options.isIdle() || now - this.lastSweepAt < DEFAULT_MIN_INTERVAL_MS) {
      return { success: false, deletedDescriptions: 0, freedBytes: 0 };
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
    return { success: true, deletedDescriptions: deleted, freedBytes: freed };
  }

  private async loadOrCreate(
    imagePath: string,
    signal: AbortSignal,
    produce: VisionDescriptionProducer,
  ): Promise<string> {
    const persisted = this.repo.find(imagePath);
    if (persisted) {
      this.repo.touch(imagePath, Date.now());
      this.putCache(imagePath, persisted.text);
      return persisted.text;
    }

    signal.throwIfAborted();
    const text = (await produce(imagePath, signal)).trim();
    signal.throwIfAborted();
    if (!text) throw new Error('Vision 没有返回可缓存的图片描述');

    this.repo.upsert(imagePath, text, Buffer.byteLength(text, 'utf8'), Date.now());
    this.putCache(imagePath, text);
    return text;
  }

  private putCache(key: string, text: string): void {
    this.cache.delete(key);
    this.cache.set(key, text);
    while (this.cache.size > this.maxMemoryEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

export interface VisionDescriptionCacheSweepOptions {
  readonly isIdle: () => boolean;
  /** 每次真正清理时读取一次;运行中的清理不被设置变更打断。 */
  readonly maxBytesForSweep: () => number;
}

export interface VisionDescriptionCacheSweepReport {
  readonly success: boolean;
  readonly deletedDescriptions: number;
  readonly freedBytes: number;
}

function sumBytes(rows: readonly { byte_size: number }[]): number {
  return rows.reduce((sum, row) => sum + row.byte_size, 0);
}
