import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentImagesRepo } from '@ema-agent/storage';
import { AttachmentPreparationError } from './errors.js';
import {
  IMAGE_NORMALIZE_MAX_BYTES,
  IMAGE_NORMALIZE_MAX_DIMENSION,
} from './limits.js';
import type { StoreSweepReport } from './types.js';
import type { AttachmentEvent } from './events.js';

const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

export interface SavedImage {
  /** 受管图片副本的绝对路径. */
  readonly path: string;
  readonly byteSize: number;
}

export class ImageStore {
  constructor(
    private readonly repo: AttachmentImagesRepo,
    private readonly dataDir: string,
    private readonly emit?: (event: AttachmentEvent) => void,
  ) {}
  
  async saveImage(
    sessionId: string,
    bytes: Buffer,
    originalName?: string,
  ): Promise<SavedImage> {
    const normalized = await this.normalize(bytes, originalName);
    const id = randomUUID();
    const dir = path.join(this.dataDir, 'sessions', sessionId, 'attachments', 'images');
    const target = path.join(dir, `${id}.${normalized.extension}`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, normalized.bytes);
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw new AttachmentPreparationError(`图片受管副本写入失败: ${originalName ?? '剪贴板图片'}`, error);
    }
    this.repo.insertMany([{
      path: target,
      session_id: sessionId,
      name: originalName ?? null,
      byte_size: normalized.bytes.length,
      created_at: Date.now(),
    }]);
    this.emit?.({ type: 'attachments_changed', sessionId });
    return { path: target, byteSize: normalized.bytes.length };
  }

  /**
   * 将图片记录绑定到当前 Turn, 返回缺失或不属于该 Session 的路径.
   * 允许重新绑定已使用的副本, 使失败请求可以重用原附件.
   */
  claimForTurn(sessionId: string, turnId: string, paths: readonly string[]): string[] {
    return this.repo.claimForTurn(sessionId, turnId, paths);
  }

  /** 返回长边不超过 maxDim 的 JPEG 缩略图, 不修改原图. */
  async readThumbnail(imagePath: string, maxDim = 256): Promise<Buffer> {
    // 缩略图请求时才加载 sharp, 文本附件和普通文件检查不需要等待图片库.
    const { default: sharp } = await import('sharp');
    return sharp(imagePath)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  async sweep(sessionId: string, olderThanMs: number, now = Date.now()): Promise<StoreSweepReport> {
    const cutoff = now - olderThanMs;
    let deletedFiles = 0;
    let freedBytes = 0;

    const stale = this.repo.listUnsentBefore(sessionId, cutoff);
    for (const row of stale) {
      await rm(row.path, { force: true }).catch(() => {});
      deletedFiles += 1;
      freedBytes += row.byte_size;
    }
    this.repo.deleteByPaths(stale.map((row) => row.path));
    if (stale.length > 0) {
      this.emit?.({ type: 'attachments_changed', sessionId });
    }

    const dir = path.join(this.dataDir, 'sessions', sessionId, 'attachments', 'images');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { deletedFiles, freedBytes };
    }
    const rowed = new Set(this.repo.listBySession(sessionId).map((row) => row.path));
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (rowed.has(fullPath)) continue;
      try {
        const metadata = await stat(fullPath);
        if (now - metadata.mtimeMs <= olderThanMs) continue;
        await rm(fullPath, { force: true });
        deletedFiles += 1;
        freedBytes += metadata.size;
      } catch {
        // 单个文件失败不阻断其他残留文件的清理.
      }
    }
    return { deletedFiles, freedBytes };
  }

  private async normalize(
    bytes: Buffer,
    originalName?: string,
  ): Promise<{ bytes: Buffer; extension: string }> {
    // 按需加载 sharp, 导入附件包或保存文本时不加载图片库.
    const { default: sharp } = await import('sharp');
    let metadata;
    try {
      metadata = await sharp(bytes).metadata();
    } catch (error) {
      throw new AttachmentPreparationError(`图片无法解码: ${originalName ?? '剪贴板图片'}`, error);
    }
    const format = metadata.format ?? '';
    if (!SUPPORTED_FORMATS.has(format)) {
      throw new AttachmentPreparationError(
        `不支持的图片格式 ${format || '未知'}: ${originalName ?? '剪贴板图片'}`,
      );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const withinLimits = bytes.length <= IMAGE_NORMALIZE_MAX_BYTES
      && width <= IMAGE_NORMALIZE_MAX_DIMENSION
      && height <= IMAGE_NORMALIZE_MAX_DIMENSION;
    if (withinLimits) {
      return { bytes, extension: format === 'jpeg' ? 'jpg' : format };
    }

    // 转换时未开启 animated, 动图只处理第一帧. 阈值内的原文件直接保留全部字节.
    const targetFormat = format === 'jpeg' ? 'jpeg' : 'png';
    let out: Buffer = await sharp(bytes)
      .resize({
        width: IMAGE_NORMALIZE_MAX_DIMENSION,
        height: IMAGE_NORMALIZE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })[targetFormat]()
      .toBuffer();
    let extension = targetFormat === 'jpeg' ? 'jpg' : 'png';
    if (out.length > IMAGE_NORMALIZE_MAX_BYTES && targetFormat !== 'jpeg') {
      out = await sharp(bytes)
        .resize({
          width: IMAGE_NORMALIZE_MAX_DIMENSION,
          height: IMAGE_NORMALIZE_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      extension = 'jpg';
    }
    // 当前只执行这一轮转换, 不保证高噪声图片的最终字节数一定低于目标阈值.
    return { bytes: out, extension };
  }
}
