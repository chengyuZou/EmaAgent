// 图片受管副本的全权 owner:粘贴/拖入时落盘到 sessions/<sid>/attachments/images/,
// 入库即规范化;发送时盖章;自己的残留自己扫。

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { AttachmentImagesRepo } from '@ema-agent/storage';
import { AttachmentPreparationError } from './errors.js';
import {
  IMAGE_NORMALIZE_MAX_BYTES,
  IMAGE_NORMALIZE_MAX_DIMENSION,
} from './limits.js';
import type { StoreSweepReport } from './types.js';

const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

export interface SavedImage {
  readonly path: string;
  readonly byteSize: number;
}

export class ImageStore {
  constructor(
    private readonly repo: AttachmentImagesRepo,
    /** Ema 数据根;副本落在 sessions/<sessionId>/attachments/images/, 随 Session 目录删除。 */
    private readonly dataDir: string,
  ) {}

  /** 字节来源由调用方读出(剪贴板直接给字节, 拖入文件由端点读盘), 域层只见字节。
   *  originalName 只在拖入场景存在;剪贴板图片没有原生名, 账本 name 存 NULL。 */
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
    return { path: target, byteSize: normalized.bytes.length };
  }

  /** 发送盖章:返回没盖上的 path(未入账或不属于该 Session)。 */
  claimForTurn(sessionId: string, turnId: string, paths: readonly string[]): string[] {
    return this.repo.claimForTurn(sessionId, turnId, paths);
  }

  /** 消息流/附件页封面用的小图:长边 ≤ maxDim 的 JPEG,原图不动。 */
  async readThumbnail(imagePath: string, maxDim = 256): Promise<Buffer> {
    return sharp(imagePath)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  /**
   * 扫自己目录的残留, 只针对这一个 Session:
   * 账本侧 turn_id IS NULL 且超龄(贴了没发)删文件销账(Vision 描述级联消失);
   * 磁盘侧无行的崩溃残渣超龄即删。目录不存在则磁盘侧零查询。
   */
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
        // 单个文件失败不阻断整轮清扫。
      }
    }
    return { deletedFiles, freedBytes };
  }

  /** 不超阈值的图原样保留; 超的先缩边长, 仍超字节再 JPEG 重编码。 */
  private async normalize(
    bytes: Buffer,
    originalName?: string,
  ): Promise<{ bytes: Buffer; extension: string }> {
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

    // sharp 不指定 animated 时 如遇到 gif 等动图只处理第一帧
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
    return { bytes: out, extension };
  }
}
