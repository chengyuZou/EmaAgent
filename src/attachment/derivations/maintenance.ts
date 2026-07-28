// 只在应用空闲且达到维护间隔时清理过期或超配额的图片 Vision 缓存。
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  AttachmentDerivationsRepo,
  AttachmentVisionDerivationRow,
  CachedAttachmentImageRow,
} from '@ema-agent/storage';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DELETE_BATCH_SIZE = 128;

export interface AttachmentCacheMaintenanceOptions {
  activeDataDir: string;
  repo: AttachmentDerivationsRepo;
  isIdle: () => boolean;
  ttlMs?: number;
  maxBytes?: number;
  /** 每次真正执行清理时读取一次，运行中的清理不会被设置变更打断。 */
  maxBytesForSweep?: () => number;
  minIntervalMs?: number;
}

export interface AttachmentCacheMaintenanceReport {
  ran: boolean;
  deletedDerivations: number;
  deletedImages: number;
  freedBytes: number;
}

export class AttachmentCacheMaintenance {
  private lastRunAt = 0;

  constructor(private readonly options: AttachmentCacheMaintenanceOptions) {}

  async sweepIfIdle(now = Date.now()): Promise<AttachmentCacheMaintenanceReport> {
    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    if (!this.options.isIdle() || now - this.lastRunAt < minInterval) {
      return {
        ran: false,
        deletedDerivations: 0,
        deletedImages: 0,
        freedBytes: 0,
      };
    }
    this.lastRunAt = now;

    let deletedDerivations = 0;
    let deletedImages = 0;
    let freedBytes = 0;
    const cutoff = now - (this.options.ttlMs ?? DEFAULT_TTL_MS);

    for (;;) {
      const expired = this.options.repo.listDerivationsBefore(cutoff, DELETE_BATCH_SIZE);
      if (expired.length === 0) break;
      for (const row of expired) {
        if (await this.deleteDerivation(row)) {
          deletedDerivations++;
          freedBytes += row.byte_size;
        }
      }
      if (expired.length < DELETE_BATCH_SIZE) break;
    }

    const maxBytes = this.options.maxBytesForSweep?.()
      ?? this.options.maxBytes
      ?? DEFAULT_MAX_BYTES;
    while (this.options.repo.totalBytes() > maxBytes) {
      const oldest = this.options.repo.listOldestDerivations(DELETE_BATCH_SIZE);
      if (oldest.length === 0) break;
      for (const row of oldest) {
        if (await this.deleteDerivation(row)) {
          deletedDerivations++;
          freedBytes += row.byte_size;
        }
        if (this.options.repo.totalBytes() <= maxBytes) break;
      }
    }

    for (;;) {
      const unused = this.options.repo.findUnreferencedImages(DELETE_BATCH_SIZE);
      if (unused.length === 0) break;
      for (const row of unused) {
        if (await this.deleteImage(row)) {
          deletedImages++;
          freedBytes += row.byte_size;
        }
      }
      if (unused.length < DELETE_BATCH_SIZE) break;
    }

    return { ran: true, deletedDerivations, deletedImages, freedBytes };
  }

  private async deleteDerivation(row: AttachmentVisionDerivationRow): Promise<boolean> {
    const filePath = resolveRelativePath(this.options.activeDataDir, row.relative_path);
    if (!await removeFile(filePath)) return false;
    this.options.repo.deleteDerivation(row.id);
    return true;
  }

  private async deleteImage(row: CachedAttachmentImageRow): Promise<boolean> {
    const filePath = resolveRelativePath(this.options.activeDataDir, row.relative_path);
    if (!await removeFile(filePath)) return false;
    this.options.repo.deleteImage(row.content_sha256);
    return true;
  }
}

async function removeFile(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return true;
    }
    return false;
  }
}

function resolveRelativePath(activeDataDir: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error('附件缓存索引不得保存绝对路径');
  const root = path.resolve(activeDataDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('附件缓存索引路径越出 activeDataDir');
  }
  return resolved;
}
