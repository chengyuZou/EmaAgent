// 管理 Turn 附件的持久记录、限额、磁盘状态与模型可见投影。

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AttachmentRepo } from '@ema-agent/storage';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { SessionOwnershipFacade } from '@ema-agent/session';
import type { Attachment, AttachmentInput, InspectedAttachment, ResolvedPrompt } from './types.js';
import { AttachmentLimitError, AttachmentNotFoundError } from './errors.js';
import { resolveForPrompt } from './resolver.js';
import {
  DEFAULT_ATTACHMENT_SETTINGS,
  type AttachmentSettings,
} from './settings.js';

// ── 接口 ───────────────────────────────────────────────────────────────────────

export interface AttachmentStorePort {
  add(input: AttachmentInput, turnId: string, sessionId: string): Attachment;
  addAll(
    inputs: AttachmentInput[],
    turnId: string,
    sessionId: string,
    limits?: Readonly<AttachmentSettings>,
  ): Attachment[];
  get(id: string): Attachment;
  listByTurn(turnId: string): Attachment[];
  listBySession(sessionId: string): Attachment[];
  inspectBySession(sessionId: string): Promise<InspectedAttachment[]>;
  remove(id: string): void;
  resolveForPrompt(attachments: Attachment[]): Promise<ResolvedPrompt>;
}

// ── 实现 ───────────────────────────────────────────────────────────────────────

export class AttachmentStore implements AttachmentStorePort {
  constructor(
    private readonly repo: AttachmentRepo,
    private readonly ownership: Pick<SessionOwnershipFacade, 'assertTurnOwnership'>,
  ) {}

  add(input: AttachmentInput, turnId: string, sessionId: string): Attachment {
    // 文件元数据写入前先过 Session Facade，避免跨 Session 引用进入仓储层。
    this.ownership.assertTurnOwnership(asSessionId(sessionId), asTurnId(turnId));
    const att: Attachment = {
      id:        input.id ?? randomUUID(),
      turnId,
      sessionId,
      name:      input.name,
      mime:      input.mimeType,
      size:      input.size,
      mtime:     input.mtime,
      localPath: input.localPath,
      createdAt: Date.now(),
    };
    this.repo.insert({
      id:        att.id,
      turnId:    att.turnId,
      sessionId: att.sessionId,
      name:      att.name,
      mime:      att.mime,
      size:      att.size,
      mtime:     att.mtime,
      localPath: att.localPath,
      createdAt: att.createdAt,
    });
    return att;
  }

  addAll(
    inputs: AttachmentInput[],
    turnId: string,
    sessionId: string,
    limits: Readonly<AttachmentSettings> = DEFAULT_ATTACHMENT_SETTINGS,
  ): Attachment[] {
    const images = inputs.filter(i => i.mimeType.startsWith('image/'));
    const files  = inputs.filter(i => !i.mimeType.startsWith('image/'));

    if (images.length > limits.maxImagesPerTurn) {
      throw new AttachmentLimitError(
        `本轮最多上传 ${limits.maxImagesPerTurn} 张图片，实际收到 ${images.length} 张`,
      );
    }
    if (files.length > limits.maxFilesPerTurn) {
      throw new AttachmentLimitError(
        `本轮最多上传 ${limits.maxFilesPerTurn} 个文件，实际收到 ${files.length} 个`,
      );
    }
    const oversizedImage = images.find((input) => input.size > limits.maxImageBytes);
    if (oversizedImage) {
      throw new AttachmentLimitError(
        `图片 ${oversizedImage.name} 超过单文件上限 ${formatMiB(limits.maxImageBytes)} MiB`,
      );
    }

    return inputs.map(i => this.add(i, turnId, sessionId));
  }

  get(id: string): Attachment {
    const row = this.repo.findById(id);
    if (!row) throw new AttachmentNotFoundError(id);
    return rowToAttachment(row);
  }

  listByTurn(turnId: string): Attachment[] {
    return this.repo.listByTurn(turnId).map(rowToAttachment);
  }

  listBySession(sessionId: string): Attachment[] {
    return this.repo.listBySession(sessionId).map(rowToAttachment);
  }

  async inspectBySession(sessionId: string): Promise<InspectedAttachment[]> {
    const attachments = this.listBySession(sessionId);
    const inspected: InspectedAttachment[] = [];

    // 一批只查询少量路径，避免超长 Session 同时向网络盘或文件系统发出大量请求。
    const inspectionBatchSize = 16;
    for (let offset = 0; offset < attachments.length; offset += inspectionBatchSize) {
      const batch = attachments.slice(offset, offset + inspectionBatchSize);
      inspected.push(...await Promise.all(batch.map(async (attachment) => ({
        ...attachment,
        fileStatus: await inspectFileStatus(attachment),
      }))));
    }
    return inspected;
  }

  remove(id: string): void {
    this.repo.deleteById(id);
  }

  resolveForPrompt(attachments: Attachment[]): Promise<ResolvedPrompt> {
    return resolveForPrompt(attachments);
  }
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function rowToAttachment(row: {
  id: string; turn_id: string; session_id: string;
  name: string; mime: string; size: number; mtime: number;
  local_path: string; created_at: number;
}): Attachment {
  return {
    id:        row.id,
    turnId:    row.turn_id,
    sessionId: row.session_id,
    name:      row.name,
    mime:      row.mime,
    size:      row.size,
    mtime:     row.mtime,
    localPath: row.local_path,
    createdAt: row.created_at,
  };
}

async function inspectFileStatus(
  attachment: Attachment,
): Promise<InspectedAttachment['fileStatus']> {
  try {
    const file = await stat(attachment.localPath);
    if (!file.isFile()) return 'missing';

    // FAT/网络盘等文件系统的时间精度可能较低，允许 1 秒误差；大小变化始终视为修改。
    const mtimeChanged = Math.abs(file.mtimeMs - attachment.mtime) > 1_000;
    return file.size !== attachment.size || mtimeChanged ? 'modified' : 'available';
  } catch (error: unknown) {
    const code = isNodeError(error) ? error.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}
