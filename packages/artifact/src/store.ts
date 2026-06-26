import * as fs   from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ArtifactRepo } from '@ema-agent/storage';
import type { Artifact, ArtifactId, SessionId } from '@ema-agent/contracts';
import type { IArtifactStore, ArtifactUpsertArgs } from '@ema-agent/tools';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Content larger than this is written to disk; DB stores empty string + path. */
const INLINE_SIZE_LIMIT = 64 * 1024;   // 64 KB

const SESSION_WARN_THRESHOLD = 100;

// ── ArtifactStore ─────────────────────────────────────────────────────────────

/**
 * Business-logic façade for artifact persistence.
 *
 * Storage split:
 *   inline (≤64 KB)  → content stored directly in the DB `content` column.
 *   file   (>64 KB)  → content written to {artifactsDir}/{id}, DB column = ''.
 *
 * The repo layer never knows about files — it stores whatever it receives.
 * This class is the only place that decides inline vs file and handles I/O.
 *
 * Implements IArtifactStore so it can be injected into ToolExecutionContext
 * without creating a package-level dependency from @ema-agent/tool to here.
 */
export class ArtifactStore implements IArtifactStore {
  constructor(
    private readonly repo: ArtifactRepo,
    /** Absolute path to the app-managed directory for large artifact files. */
    private readonly artifactsDir: string,
  ) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  // ── upsert ──────────────────────────────────────────────────────────────────

  upsert(args: ArtifactUpsertArgs): Artifact {
    const now      = Date.now();
    const id       = (args.id ?? randomUUID()) as ArtifactId;
    const existing = args.id ? this.repo.findById(args.id as ArtifactId) : null;

    const isLarge = args.content.length > INLINE_SIZE_LIMIT;

    // ── Determine storage location ─────────────────────────────────────────
    // For file-backed content: .tmp write → DB write → rename (atomic).
    // file-backed content: contractually requires content: null (not '').

    let tmpPath: string | undefined;

    // Base fields shared by both branches
    const base = {
      id,
      sessionId: args.sessionId,
      turnId:    args.turnId,
      type:      args.type,
      title:     args.title,
      meta:      args.meta ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Status fields — forward existing values, never clear them here.
      // appliedAt/rejectedAt live in the ArtifactStatus discriminant so cast via unknown.
      ...((existing as unknown as { appliedAt?: number } | null)?.appliedAt  != null
        ? { appliedAt:  (existing as unknown as { appliedAt: number }).appliedAt  } : {}),
      ...((existing as unknown as { rejectedAt?: number } | null)?.rejectedAt != null
        ? { rejectedAt: (existing as unknown as { rejectedAt: number }).rejectedAt } : {}),
    };

    let artifactForDb: Artifact;

    if (isLarge) {
      const contentPath = path.join(this.artifactsDir, id);
      tmpPath = contentPath + '.tmp';
      // 1. Write to .tmp — DB is untouched yet
      fs.writeFileSync(tmpPath, args.content, 'utf8');
      artifactForDb = { ...base, contentLocation: 'file', content: null, contentPath } as Artifact;
    } else {
      artifactForDb = { ...base, contentLocation: 'inline', content: args.content } as Artifact;
    }

    // 2. DB write (may throw — .tmp file stays unlinked from DB, safe to GC)
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

    // 3. Atomic rename — only reached when DB write succeeded
    if (tmpPath) {
      const contentPath = (artifactForDb as { contentPath: string }).contentPath;
      fs.renameSync(tmpPath, contentPath);
    }

    // 4. Clean up old file after DB update confirmed (file→inline transition)
    if (!isLarge && existing?.contentLocation === 'file' && existing.contentPath) {
      try { fs.rmSync(existing.contentPath, { force: true }); } catch { /* tolerated orphan */ }
    }

    // Return full content to caller — callers never see null for content
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

  /** Metadata-only list — content field intentionally omitted. */
  list(sessionId: SessionId, opts?: { type?: string }): Omit<Artifact, 'content'>[] {
    return this.repo.listBySession(sessionId, { type: opts?.type, includeContent: false });
  }

  /** Export-only: full artifacts including inline content and file-backed paths. */
  listForExport(sessionId: SessionId): Artifact[] {
    return this.repo.listForExport(sessionId);
  }

  // ── apply ───────────────────────────────────────────────────────────────────

  /**
   * Copy artifact content to targetPath in the user's workspace.
   * Route handler must validate targetPath is within workspaceRoot before calling.
   */
  apply(id: ArtifactId, targetPath: string): Artifact {
    const artifact = this.repo.findById(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);

    const filled = this.fillContent(artifact);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    // Write to .tmp first so a crash between file write and DB update
    // leaves no user-visible half-written workspace file.
    const tmpPath = targetPath + '.ema-tmp';
    fs.writeFileSync(tmpPath, filled.content ?? '', 'utf8');

    const now = Date.now();
    this.repo.update(id, { appliedAt: now, updatedAt: now });

    // DB succeeded — atomically place the file
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
    // DB row first — if the file cleanup fails the artifact is already gone
    // from the DB (no dangling reference). The orphaned file can be swept
    // later by a garbage-collection pass.
    this.repo.deleteById(id);
    if (artifact.contentLocation === 'file' && artifact.contentPath) {
      try { fs.rmSync(artifact.contentPath, { force: true }); } catch { /* tolerated orphan */ }
    }
  }

  // ── countWarning ────────────────────────────────────────────────────────────

  countWarning(sessionId: SessionId): boolean {
    return this.repo.countBySession(sessionId) > SESSION_WARN_THRESHOLD;
  }

  // ── private helpers ──────────────────────────────────────────────────────────

  private fillContent(artifact: Artifact): Artifact {
    if (artifact.contentLocation !== 'file') return artifact;
    const filePath = artifact.contentPath;
    // Spread replaces content: null with a real string — use unknown cast to satisfy TS.
    if (!filePath) return { ...artifact, content: '' } as unknown as Artifact;
    try {
      return { ...artifact, content: fs.readFileSync(filePath, 'utf8') } as unknown as Artifact;
    } catch {
      return { ...artifact, content: '' } as unknown as Artifact;
    }
  }
}
