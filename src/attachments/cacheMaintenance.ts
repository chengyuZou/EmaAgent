// 空闲时清理过期或超预算的 Vision 文本描述；附件副本随 Session 目录删除，不在此维护。

import type {
  AttachmentVisionDescriptionsRepo,
} from '@ema-agent/storage';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DELETE_BATCH_SIZE = 128;

export interface AttachmentCacheMaintenanceOptions {
  readonly repo: AttachmentVisionDescriptionsRepo;
  readonly isIdle: () => boolean;
  /** 每次真正清理时读取一次；运行中的清理不被设置变更打断。 */
  readonly maxBytesForSweep: () => number;
}

export interface AttachmentCacheMaintenanceReport {
  readonly ran: boolean;
  readonly deletedDescriptions: number;
  readonly freedBytes: number;
}

export class AttachmentCacheMaintenance {
  private lastRunAt = 0;

  constructor(private readonly options: AttachmentCacheMaintenanceOptions) {}

  async sweepIfIdle(now = Date.now()): Promise<AttachmentCacheMaintenanceReport> {
    if (!this.options.isIdle() || now - this.lastRunAt < DEFAULT_MIN_INTERVAL_MS) {
      return { ran: false, deletedDescriptions: 0, freedBytes: 0 };
    }

    let deleted = 0;
    let freed = 0;
    const cutoff = now - DEFAULT_TTL_MS;

    // TTL：最后访问早于规定时间的描述整批过期。
    for (;;) {
      const expired = this.options.repo.listAccessedBefore(cutoff, DELETE_BATCH_SIZE);
      if (expired.length === 0) break;
      freed += sumBytes(expired);
      deleted += this.options.repo.deleteRows(expired.map(row => row.attachment_id));
      if (expired.length < DELETE_BATCH_SIZE) break;
    }

    // 预算：仍超限时从最久未访问开始逐条驱逐，回到预算内即停。
    const maxBytes = this.options.maxBytesForSweep();
    while (this.options.repo.totalBytes() > maxBytes) {
      const oldest = this.options.repo.listOldest(DELETE_BATCH_SIZE);
      if (oldest.length === 0) break;
      for (const row of oldest) {
        freed += row.byte_size;
        deleted += this.options.repo.deleteRows([row.attachment_id]);
        if (this.options.repo.totalBytes() <= maxBytes) break;
      }
    }

    // lastRunAt 只在真正完成一轮后更新；失败允许下个后台周期重试。
    this.lastRunAt = now;
    return { ran: true, deletedDescriptions: deleted, freedBytes: freed };
  }
}

function sumBytes(rows: readonly { byte_size: number }[]): number {
  return rows.reduce((sum, row) => sum + row.byte_size, 0);
}
