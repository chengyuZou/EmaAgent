// 附件登记：realpath/stat 权威化、限额、图片原始字节复制落盘、单事务批量写入。
// 图片不做规范化（不旋转/不缩放/不转码）；受管副本保证原文件消失后历史仍可重放。

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentInsertRow, AttachmentRepo, AttachmentRow } from '@ema-agent/storage';
import { AttachmentLimitError, AttachmentPreparationError } from './errors.js';
import type { TurnAttachmentInput } from './protocol.js';
import {
  MAX_FILES_PER_TURN,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} from './limits.js';
import type {
  Attachment,
  AttachmentSourceStatus,
  InspectedAttachment,
} from './types.js';

export interface AttachmentStoreDeps {
  readonly repo: AttachmentRepo;
  /** Ema 数据根；受管副本落在 sessions/<sessionId>/attachments/，随 Session 目录删除。 */
  readonly dataDir: string;
}

interface PreparedAttachment {
  readonly id: string;
  readonly kind: 'file' | 'image';
  readonly name: string;
  readonly mimeType: string;
  readonly sourcePath: string;
  readonly byteSize: number;
  readonly sourceModifiedAt: number;
}

export class AttachmentStore {
  constructor(private readonly deps: AttachmentStoreDeps) {}

  /**
   * 登记一批附件：先完成全部分类与图片落盘，再单事务写库。
   * 任何一步失败都不留下半成品：库未写则已发布副本删除。
   */
  async addAll(
    inputs: readonly TurnAttachmentInput[],
    turnId: string,
    sessionId: string,
  ): Promise<readonly Attachment[]> {
    if (inputs.length === 0) return [];

    const prepared: PreparedAttachment[] = [];
    for (const input of inputs) {
      prepared.push(await this.prepareOne(input));
    }

    const images = prepared.filter((item) => item.kind === 'image');
    const files = prepared.filter((item) => item.kind === 'file');
    if (images.length > MAX_IMAGES_PER_TURN) {
      throw new AttachmentLimitError(
        `本轮最多上传 ${MAX_IMAGES_PER_TURN} 张图片, 实际收到 ${images.length} 张`,
      );
    }
    if (files.length > MAX_FILES_PER_TURN) {
      throw new AttachmentLimitError(
        `本轮最多上传 ${MAX_FILES_PER_TURN} 个文件, 实际收到 ${files.length} 个`,
      );
    }
    const oversized = images.find((item) => item.byteSize > MAX_IMAGE_BYTES);
    if (oversized) {
      throw new AttachmentLimitError(
        `图片 ${oversized.name} 超过单文件上限 ${formatMiB(MAX_IMAGE_BYTES)} MiB`,
      );
    }

    const now = Date.now();
    const publishedPaths: string[] = [];
    const rows: AttachmentInsertRow[] = [];
    try {
      for (const item of prepared) {
        if (item.kind === 'file') {
          rows.push({
            id: item.id, turn_id: turnId, session_id: sessionId,
            kind: 'file', name: item.name, mime: item.mimeType,
            source_path: item.sourcePath, byte_size: item.byteSize,
            source_modified_at: item.sourceModifiedAt,
            image_path: null, image_byte_size: null,
            created_at: now,
          });
          continue;
        }
        const copy = await this.publishImageCopy(sessionId, item);
        publishedPaths.push(copy.imagePath);
        rows.push({
          id: item.id, turn_id: turnId, session_id: sessionId,
          kind: 'image', name: item.name, mime: item.mimeType,
          source_path: item.sourcePath, byte_size: item.byteSize,
          source_modified_at: item.sourceModifiedAt,
          image_path: copy.imagePath, image_byte_size: copy.imageByteSize,
          created_at: now,
        });
      }
      this.deps.repo.insertMany(rows);
    } catch (error) {
      // 库未提交时清掉本批已发布副本；反之亦然（调用方看到整体失败）。
      await removeQuietly(publishedPaths);
      throw error instanceof AttachmentLimitError || error instanceof AttachmentPreparationError
        ? error
        : new AttachmentPreparationError('附件登记失败', error);
    }

    return rows.map((row) => rowToAttachment(row));
  }

  listByTurn(turnId: string): readonly Attachment[] {
    return this.deps.repo.listByTurn(turnId).map((row) => rowToAttachment(row));
  }

  listBySession(sessionId: string): readonly Attachment[] {
    return this.deps.repo.listBySession(sessionId).map((row) => rowToAttachment(row));
  }

  getMany(ids: readonly string[]): ReadonlyMap<string, Attachment> {
    const map = new Map<string, Attachment>();
    for (const row of this.deps.repo.findByIds(ids)) {
      map.set(row.id, rowToAttachment(row));
    }
    return map;
  }

  /** 逐条检查用户原文件当前状态；网络盘慢速时按小批并发，避免一次压上百个 stat。 */
  async inspectBySession(sessionId: string): Promise<readonly InspectedAttachment[]> {
    const rows = this.deps.repo.listBySession(sessionId);
    const inspected: InspectedAttachment[] = [];
    const batchSize = 16;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      inspected.push(...await Promise.all(batch.map(async (row) => ({
        ...rowToAttachment(row),
        sourceStatus: await inspectSourceStatus(row),
      }))));
    }
    return inspected;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private async prepareOne(input: TurnAttachmentInput): Promise<PreparedAttachment> {
    let canonical: string;
    try {
      canonical = await realpath(input.sourcePath);
    } catch (error) {
      throw new AttachmentPreparationError(`附件路径不存在或不可读: ${input.sourcePath}`, error);
    }
    let metadata;
    try {
      metadata = await stat(canonical);
    } catch (error) {
      throw new AttachmentPreparationError(`附件不可读取: ${canonical}`, error);
    }
    if (!metadata.isFile()) {
      throw new AttachmentPreparationError(`附件不是普通文件: ${canonical}`);
    }
    const name = path.basename(canonical);
    const mimeType = mimeForFileName(name);
    return {
      id: randomUUID(),
      kind: LLM_IMAGE_MIMES.has(mimeType) ? 'image' : 'file',
      name,
      mimeType,
      sourcePath: canonical,
      byteSize: metadata.size,
      sourceModifiedAt: Math.trunc(metadata.mtimeMs),
    };
  }

  /** 原始字节复制：临时名写入后同卷 rename 原子发布；不做任何转码。 */
  private async publishImageCopy(
    sessionId: string,
    item: PreparedAttachment,
  ): Promise<{ imagePath: string; imageByteSize: number }> {
    const dir = path.join(this.deps.dataDir, 'sessions', sessionId, 'attachments');
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${item.id}${path.extname(item.name)}`);
    const temp = path.join(dir, `.${item.id}.tmp`);
    try {
      await copyFile(item.sourcePath, temp);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw new AttachmentPreparationError(`图片受管副本写入失败: ${item.name}`, error);
    }
    return { imagePath: target, imageByteSize: item.byteSize };
  }
}

// ── 行映射与源状态 ────────────────────────────────────────────────────────────

function rowToAttachment(row: AttachmentRow): Attachment {
  const base = {
    id: row.id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    name: row.name,
    createdAt: row.created_at,
  };
  if (row.kind === 'image') {
    return {
      ...base,
      kind: 'image',
      mimeType: row.mime,
      sourcePath: row.source_path,
      sourceByteSize: row.byte_size,
      sourceModifiedAt: row.source_modified_at,
      // CHECK((kind = 'image') = (image_path IS NOT NULL)) 在库层强制非空。
      imagePath: row.image_path!,
      imageByteSize: row.image_byte_size ?? row.byte_size,
    };
  }
  return {
    ...base,
    kind: 'file',
    mimeType: row.mime,
    sourcePath: row.source_path,
    byteSize: row.byte_size,
    sourceModifiedAt: row.source_modified_at,
  };
}

async function inspectSourceStatus(row: AttachmentRow): Promise<AttachmentSourceStatus> {
  try {
    const file = await stat(row.source_path);
    if (!file.isFile()) return 'missing';
    // FAT/网络盘时间精度较低，允许 1 秒误差；大小变化始终视为修改。
    const mtimeChanged = Math.abs(file.mtimeMs - row.source_modified_at) > 1_000;
    return file.size !== row.byte_size || mtimeChanged ? 'modified' : 'available';
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
}

async function removeQuietly(paths: readonly string[]): Promise<void> {
  for (const target of paths) {
    await rm(target, { force: true }).catch(() => {});
  }
}

// ── MIME 识别（扩展名口径，Attachments 拥有；前端预览另有展示用副本） ──────────

/**
 * LLM 图片输入只担保这四类（llm/protocolInput 的协议断言同款集合）；
 * bmp/avif/svg 等其余图片格式按普通 file 登记为路径引用，不走 image_data。
 */
const LLM_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const EXTENSION_MIME: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.md':   'text/markdown',
  '.txt':  'text/plain',
  '.log':  'text/plain',
  '.csv':  'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip':  'application/zip',
};

function mimeForFileName(name: string): string {
  return EXTENSION_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}
