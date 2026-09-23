// 在文本输入框粘贴大段文本时写成 sessions/<sid>/attachments/pasted/<uuid>.txt

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentPastedTextsRepo } from '@ema-agent/storage';
import { AttachmentPreparationError } from './errors.js';
import { PASTE_TEXT_MIN_CHARS, PASTE_TEXT_PREVIEW_CHARS } from './limits.js';
import type { StoreSweepReport } from './types.js';
import type { AttachmentEvent } from './events.js';

/**
 * @param path 粘贴文本文件绝对路径
 * @param byteSize 粘贴文本文件字节数
 * @param preview 粘贴文本的前若干字符, 用于前端展示
 */
export interface SavedPastedText {
  readonly path: string;
  readonly byteSize: number;
  readonly preview: string;
}

export class PastedTextStore {
  constructor(
    private readonly repo: AttachmentPastedTextsRepo,
    private readonly dataDir: string,
    private readonly emit?: (event: AttachmentEvent) => void,
  ) {}

  async savePastedText(sessionId: string, content: string): Promise<SavedPastedText> {
    if (content.length < PASTE_TEXT_MIN_CHARS) {
      throw new AttachmentPreparationError(
        `粘贴文本不足 ${PASTE_TEXT_MIN_CHARS} 字符, 不应落成文件`,
      );
    }
    const id = randomUUID();
    const dir = path.join(this.dataDir, 'sessions', sessionId, 'attachments', 'pasted');
    const target = path.join(dir, `${id}.txt`);
    const bytes = Buffer.byteLength(content, 'utf8');
    try {
      await mkdir(dir, { recursive: true });
      // 直接写最终路径,错误文件会在每次开软件时被扫掉, 不再做临时文件再搬运
      await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      await rm(target, { force: true }).catch(() => {});
      throw new AttachmentPreparationError('粘贴文本写入失败', error);
    }
    this.repo.insert({
      path: target,
      session_id: sessionId,
      byte_size: bytes,
      created_at: Date.now(),
    });
    this.emit?.({ type: 'attachments_changed', sessionId });
    return {
      path: target,
      byteSize: bytes,
      preview: content.slice(0, PASTE_TEXT_PREVIEW_CHARS),
    };
  }

  /**
   * 发送前认领本次消息引用的粘贴文本, 将有效条目绑定到当前 Turn.
   * @param paths 发送消息引用的粘贴文本路径
   * @returns 无法认领的 path, 例如已被用户删除 未入账或不属于当前 Session.
   */
  claimForTurn(sessionId: string, turnId: string, paths: readonly string[]): string[] {
    return this.repo.claimForTurn(sessionId, turnId, paths);
  }

  /**
   * 清扫 Repo 以及本地文件系统中过期的粘贴文本文件, 释放磁盘空间.
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
    if (stale.length > 0) this.emit?.({ type: 'attachments_changed', sessionId });

    const dir = path.join(this.dataDir, 'sessions', sessionId, 'attachments', 'pasted');
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
        // 单个文件失败不阻断整轮清扫
      }
    }
    return { deletedFiles, freedBytes };
  }
}
