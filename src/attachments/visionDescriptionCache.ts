// Vision 文本描述缓存：每个受管附件保留一份规范描述，同附件并发只生产一次。

import type {
  AttachmentVisionDescriptionsRepo,
} from '@ema-agent/storage';
import type { ImageAttachment } from './types.js';

const DEFAULT_MEMORY_ENTRIES = 256;

export type VisionDescriptionProducer = (
  attachment: ImageAttachment,
) => Promise<string>;

export class VisionDescriptionCache {
  /** 同键正在生产的 Promise：并发调用共享一次付费生产。 */
  private readonly inFlight = new Map<string, Promise<string>>();
  /** 内存 LRU：delete+set 即刷新热度；淘汰最久未命中者。 */
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly repo: AttachmentVisionDescriptionsRepo,
    private readonly maxMemoryEntries = DEFAULT_MEMORY_ENTRIES,
  ) {}

  async getOrCreate(
    attachment: ImageAttachment,
    signal: AbortSignal,
    produce: VisionDescriptionProducer,
  ): Promise<string> {
    const key = attachment.id;

    const memoryHit = this.memory.get(key);
    if (memoryHit !== undefined) {
      // LRU 命中刷新：delete+set 移到最新端。
      this.memory.delete(key);
      this.memory.set(key, memoryHit);
      return memoryHit;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = this.loadOrCreate(key, attachment, signal, produce);
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

  private async loadOrCreate(
    key: string,
    attachment: ImageAttachment,
    signal: AbortSignal,
    produce: VisionDescriptionProducer,
  ): Promise<string> {
    const persisted = this.repo.find(attachment.id);
    if (persisted) {
      this.repo.touch(attachment.id, Date.now());
      this.putMemory(key, persisted.text);
      return persisted.text;
    }

    signal.throwIfAborted();
    const text = (await produce(attachment)).trim();
    signal.throwIfAborted();
    if (!text) throw new Error('Vision 没有返回可缓存的图片描述');

    this.repo.upsert(attachment.id, text, Buffer.byteLength(text, 'utf8'), Date.now());
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
