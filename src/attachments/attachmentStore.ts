// 附件总入口:只知道"有什么操作", 不知道"怎么操作"。
// 落盘/盖章/清扫的怎么做全权归 imageStore 与 pasteStore;file 块没有自己的 store,
// 发送时的 realpath/stat 权威化是这里唯一直接干的活。

import { realpath, stat } from 'node:fs/promises';
import type { AttachmentBlock } from '@ema-agent/session';
import { AttachmentPreparationError } from './errors.js';
import type { ImageStore } from './imageStore.js';
import type { PastedTextStore } from './pasteStore.js';
import type { StoreSweepReport } from './types.js';

export interface AttachmentStoreDeps {
  readonly imageStore: ImageStore;
  readonly pasteStore: PastedTextStore;
}

/** 两侧清扫各自结算:一侧炸了另一侧的结果照样收, 不整轮失败。 */
export interface AttachmentSweepReport {
  readonly images: PromiseSettledResult<StoreSweepReport>;
  readonly pasted: PromiseSettledResult<StoreSweepReport>;
}

export class AttachmentStore {
  constructor(private readonly deps: AttachmentStoreDeps) {}

  /**
   * 发送时校验与盖章:file 块 realpath/stat 权威化;image/pasted 块转发各自
   * store 盖章(NULL → 当前 Turn), 盖不上 = 账本缺行或跨 Session, 硬失败。
   */
  async attach(
    sessionId: string,
    turnId: string,
    blocks: readonly AttachmentBlock[],
  ): Promise<AttachmentBlock[]> {
    const missing = [
      ...this.deps.imageStore.claimForTurn(
        sessionId,
        turnId,
        blocks.filter((b) => b.type === 'image_reference').map((b) => b.path),
      ),
      ...this.deps.pasteStore.claimForTurn(
        sessionId,
        turnId,
        blocks.filter((b) => b.type === 'pasted_text_reference').map((b) => b.path),
      ),
    ];
    if (missing.length > 0) {
      throw new AttachmentPreparationError(`附件账本缺少记录: ${missing.join(', ')}`);
    }

    const result: AttachmentBlock[] = [];
    for (const block of blocks) {
      if (block.type === 'file_reference') {
        result.push({ type: 'file_reference', path: await this.authorizeFile(block.path) });
      } else {
        result.push(block);
      }
    }
    return result;
  }

  /** 清扫转发:并发结算两个 store 各自的残留, 按侧汇报成败。 */
  async sweep(
    sessionId: string,
    olderThanMs: number,
    now = Date.now(),
  ): Promise<AttachmentSweepReport> {
    const [images, pasted] = await Promise.allSettled([
      this.deps.imageStore.sweep(sessionId, olderThanMs, now),
      this.deps.pasteStore.sweep(sessionId, olderThanMs, now),
    ]);
    return { images, pasted };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async authorizeFile(sourcePath: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(sourcePath);
    } catch (error) {
      throw new AttachmentPreparationError(`附件路径不存在或不可读: ${sourcePath}`, error);
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
    return canonical;
  }
}
