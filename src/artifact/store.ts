// 这里管理 Artifact 产物：存（小内容进 DB、大内容落文件）、取、应用到工作区、拒绝、删除。

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  asSessionId,
  type SessionId,
} from '@ema-agent/contracts';
import { ArtifactOwnershipError } from './errors.js';
import type {
  Artifact,
  ArtifactId,
  ArtifactOwnership,
  ArtifactPersistence,
  ArtifactUpsertArgs,
  IArtifactStore,
} from './types.js';

// ── 常量 ───────────────────────────────────────────────────────────────────────

/** 超过这个大小的内容写到磁盘，DB 只存空字符串 + 路径。 */
const INLINE_SIZE_LIMIT = 64 * 1024;   // 64 KB

const SESSION_WARN_THRESHOLD = 100;

// ── ArtifactStore ─────────────────────────────────────────────────────────────

/**
 * Artifact 持久化的业务逻辑 Facade。
 *
 * 存储分两种：
 *   inline（≤64 KB）-> 内容直接存 DB 的 content 列。
 *   file（>64 KB）  -> 内容写到 {artifactsDir}/{id}，DB 列为 ''。
 *
 * 仓储层不感知文件——它只存收到的内容。inline 还是 file 的决策和文件 I/O
 * 只在本类里发生。
 *
 * 实现 IArtifactStore，这样能注入到 ToolExecutionContext，而不用让
 * @ema-agent/tools 反向依赖本包。
 */
export class ArtifactStore implements IArtifactStore {
  constructor(
    private readonly repo: ArtifactPersistence,
    /**
     * 按 Session 划分的目录树根（`{dataDir}/sessions`）。每个文件型产物落在
     * `{sessionsRoot}/{sessionId}/artifacts/{id}`，和该 Session 的 audio/scratchpad
     * 放一起，由 `removeSessionDir` 统一清理。
     */
    private readonly sessionsRoot: string,
    private readonly ownership: ArtifactOwnership,
  ) {
    // 按 Session 的子目录在 upsert() 里按需创建。
  }

  // ── upsert ──────────────────────────────────────────────────────────────────

  upsert(args: ArtifactUpsertArgs): Artifact {
    const now      = Date.now();
    const id       = (args.id ?? randomUUID()) as ArtifactId;
    const existing = args.id ? this.repo.findById(args.id as ArtifactId) : null;

    // 所有归属检查必须早于文件 I/O，失败时不能留下临时文件或错误目录。
    if (existing && existing.sessionId !== args.sessionId) {
      throw new ArtifactOwnershipError(
        id,
        args.sessionId,
        asSessionId(existing.sessionId),
      );
    }
    if (args.turnId) {
      this.ownership.assertTurnOwnership(args.sessionId, args.turnId);
    }

    const isLarge = args.content.length > INLINE_SIZE_LIMIT;

    // ── 决定存储位置 ───────────────────────────────────────────────────────
    // 文件型内容：.tmp 写入 -> DB 写入 -> rename（原子）。
    // 文件型内容按约定要求 content: null（不是 ''）。

    let tmpPath: string | undefined;

    // 两个分支共用的基础字段
    const base = {
      id,
      sessionId: args.sessionId,
      turnId:    args.turnId,
      type:      args.type,
      title:     args.title,
      meta:      args.meta ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // 状态字段——透传已有值，这里绝不清空。
      // appliedAt/rejectedAt 在 ArtifactStatus 判别式里，通过 unknown 转型。
      ...((existing as unknown as { appliedAt?: number } | null)?.appliedAt  != null
        ? { appliedAt:  (existing as unknown as { appliedAt: number }).appliedAt  } : {}),
      ...((existing as unknown as { rejectedAt?: number } | null)?.rejectedAt != null
        ? { rejectedAt: (existing as unknown as { rejectedAt: number }).rejectedAt } : {}),
    };

    let artifactForDb: Artifact;

    if (isLarge) {
      const artDir = path.join(this.sessionsRoot, args.sessionId as string, 'artifacts');
      fs.mkdirSync(artDir, { recursive: true });
      const contentPath = path.join(artDir, id);
      tmpPath = contentPath + '.tmp';
      // 1. 先写 .tmp——DB 还没动
      fs.writeFileSync(tmpPath, args.content, 'utf8');
      artifactForDb = { ...base, contentLocation: 'file', content: null, contentPath } as Artifact;
    } else {
      artifactForDb = { ...base, contentLocation: 'inline', content: args.content } as Artifact;
    }

    // 2. 写 DB（可能抛错——.tmp 文件没和 DB 关联，可安全 GC）
    if (existing) {
      this.repo.update(id, {
        content:         isLarge ? null : args.content,
        contentLocation: artifactForDb.contentLocation,
        contentPath:     isLarge ? (artifactForDb as { contentPath: string }).contentPath : undefined,
        title:           args.title,
        type:            args.type,
        meta:            args.meta ?? {},
        updatedAt:       now,
      });
    } else {
      this.repo.insert(artifactForDb);
    }

    // 3. 原子 rename——只有 DB 写成功才走到这里
    if (tmpPath) {
      const contentPath = (artifactForDb as { contentPath: string }).contentPath;
      fs.renameSync(tmpPath, contentPath);
    }

    // 4. DB 更新确认后清理旧文件（file -> inline 转换时）
    if (!isLarge && existing?.contentLocation === 'file' && existing.contentPath) {
      try { fs.rmSync(existing.contentPath, { force: true }); } catch { /* 容忍孤儿文件 */ }
    }

    // 把完整内容返回给调用方——调用方永远看不到 content 为 null
    return isLarge
      ? { ...artifactForDb, content: args.content } as Artifact
      : artifactForDb;
  }

  // ── get ─────────────────────────────────────────────────────────────────────

  get(id: ArtifactId): Artifact | null {
    const artifact = this.repo.findById(id);
    if (!artifact) return null;
    return this.fillContent(artifact);
  }

  // ── list ────────────────────────────────────────────────────────────────────

  /** 只返回元数据，故意不含 content 字段。 */
  list(sessionId: SessionId, opts?: { type?: string }): Omit<Artifact, 'content'>[] {
    return this.repo.listBySession(sessionId, { type: opts?.type, includeContent: false });
  }

  /** 仅导出用：完整产物，含 inline 内容和文件型路径。 */
  listForExport(sessionId: SessionId): Artifact[] {
    return this.repo.listForExport(sessionId);
  }

  // ── apply ───────────────────────────────────────────────────────────────────

  /**
   * 把产物内容复制到用户工作区的 targetPath。
   * 路由层在调用前必须校验 targetPath 在 workspaceRoot 内。
   */
  apply(id: ArtifactId, targetPath: string): Artifact {
    const artifact = this.repo.findById(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);

    const filled = this.fillContent(artifact);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    // 先写 .tmp，这样文件写和 DB 更新之间崩溃的话，工作区不会留下写一半的文件。
    const tmpPath = targetPath + '.ema-tmp';
    fs.writeFileSync(tmpPath, filled.content ?? '', 'utf8');

    const now = Date.now();
    this.repo.update(id, { appliedAt: now, updatedAt: now });

    // DB 成功——原子地把文件放到位
    fs.renameSync(tmpPath, targetPath);

    return { ...filled, appliedAt: now, updatedAt: now } as Artifact;
  }

  // ── reject ──────────────────────────────────────────────────────────────────

  reject(id: ArtifactId): Artifact {
    const artifact = this.repo.findById(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    const now = Date.now();
    this.repo.update(id, { rejectedAt: now, updatedAt: now });
    return this.fillContent({ ...artifact, rejectedAt: now, updatedAt: now } as Artifact);
  }

  // ── delete ──────────────────────────────────────────────────────────────────

  delete(id: ArtifactId): void {
    const artifact = this.repo.findById(id);
    if (!artifact) return;
    // 先删 DB 行——如果文件清理失败，产物已经从 DB 消失（无悬挂引用）。
    // 孤儿文件可以后续 GC 扫一遍清掉。
    this.repo.deleteById(id);
    if (artifact.contentLocation === 'file' && artifact.contentPath) {
      try { fs.rmSync(artifact.contentPath, { force: true }); } catch { /* 容忍孤儿文件 */ }
    }
  }

  // ── countWarning ────────────────────────────────────────────────────────────

  countWarning(sessionId: SessionId): boolean {
    return this.repo.countBySession(sessionId) > SESSION_WARN_THRESHOLD;
  }

  // ── 私有辅助 ──────────────────────────────────────────────────────────────────

  private fillContent(artifact: Artifact): Artifact {
    if (artifact.contentLocation !== 'file') return artifact;
    const filePath = artifact.contentPath;
    // spread 会把 content: null 换成真实字符串，用 unknown 转型满足 TS。
    if (!filePath) return { ...artifact, content: '' } as unknown as Artifact;
    try {
      return { ...artifact, content: fs.readFileSync(filePath, 'utf8') } as unknown as Artifact;
    } catch {
      return { ...artifact, content: '' } as unknown as Artifact;
    }
  }
}
