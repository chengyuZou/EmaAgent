// 粘贴长文本的全权 owner:粘贴那一刻写成 sessions/<sid>/attachments/pasted/<uuid>.txt
// 并入账;发送时盖章;自己的残留自己扫。
// 上下文只携带 path, 模型要内容走 Read 分页读; 文本本身不设大小上限。

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentPastedTextsRepo } from '@ema-agent/storage';
import { AttachmentPreparationError } from './errors.js';
import { PASTE_TEXT_MIN_CHARS } from './limits.js';
import type { StoreSweepReport } from './types.js';

export interface SavedPastedText {
  readonly path: string;
  readonly byteSize: number;
}

export class PastedTextStore {
  constructor(
    private readonly repo: AttachmentPastedTextsRepo,
    private readonly dataDir: string,
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
      // 直写最终路径(两家同款);写一半崩了留下的是无行残渣,归磁盘侧清扫。
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
    return { path: target, byteSize: bytes };
  }

  /** 发送盖章:返回没盖上的 path(未入账或不属于该 Session)。 */
  claimForTurn(sessionId: string, turnId: string, paths: readonly string[]): string[] {
    return this.repo.claimForTurn(sessionId, turnId, paths);
  }

  /**
   * 扫自己目录的残留, 只针对这一个 Session:
   * 账本侧 turn_id IS NULL 且超龄(贴了没发)删文件销账;
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
        // 单个文件失败不阻断整轮清扫。
      }
    }
    return { deletedFiles, freedBytes };
  }
}
