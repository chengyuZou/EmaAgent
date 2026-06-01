import * as fs   from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ArtifactRepo } from '@ema-agent/storage';
import type { Artifact, ArtifactId, SessionId } from '@ema-agent/contracts';
import type { IArtifactStore, ArtifactUpsertArgs } from '@ema-agent/tool';

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

    let contentLocation: 'inline' | 'file';
    let contentForDb:    string;
    let contentPath:     string | undefined;

    if (isLarge) {
      // Large content → write to managed file, DB column stays empty
      contentLocation = 'file';
      contentPath     = path.join(this.artifactsDir, id);
      contentForDb    = '';
      fs.writeFileSync(contentPath, args.content, 'utf8');
    } else if (existing?.contentLocation === 'file' && existing.contentPath) {
      // Previously large, now small → switch to inline, delete old file
      contentLocation = 'inline';
      contentForDb    = args.content;
      contentPath     = undefined;
      fs.rmSync(existing.contentPath, { force: true });
    } else {
      contentLocation = 'inline';
      contentForDb    = args.content;
    }

    const artifactForDb: Artifact = {
      id,
      sessionId:       args.sessionId,
      turnId:          args.turnId,
      type:            args.type,
      title:           args.title,
      content:         contentForDb,   // '' when file mode
      contentLocation,
      contentPath,
      meta:            args.meta ?? {},
      appliedAt:       existing?.appliedAt,
      rejectedAt:      existing?.rejectedAt,
      createdAt:       existing?.createdAt ?? now,
      updatedAt:       now,
    };

    if (existing) {
      this.repo.update(id, {
        content:         artifactForDb.content,
        contentLocation: artifactForDb.contentLocation,
        contentPath:     artifactForDb.contentPath,
        title:           artifactForDb.title,
        type:            artifactForDb.type,
        meta:            artifactForDb.meta,
        updatedAt:       now,
      });
    } else {
      this.repo.insert(artifactForDb);
    }

    // Always return full content to caller — never expose the empty-string sentinel
    return { ...artifactForDb, content: args.content };
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
    fs.writeFileSync(targetPath, filled.content ?? '', 'utf8');

    const now = Date.now();
    this.repo.update(id, { appliedAt: now, updatedAt: now });
    return { ...filled, appliedAt: now, updatedAt: now };
  }

  // ── reject ──────────────────────────────────────────────────────────────────

  reject(id: ArtifactId): Artifact {
    const artifact = this.repo.findById(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    const now = Date.now();
    this.repo.update(id, { rejectedAt: now, updatedAt: now });
    return this.fillContent({ ...artifact, rejectedAt: now, updatedAt: now });
  }

  // ── delete ──────────────────────────────────────────────────────────────────

  delete(id: ArtifactId): void {
    const artifact = this.repo.findById(id);
    if (!artifact) return;
    if (artifact.contentLocation === 'file' && artifact.contentPath) {
      fs.rmSync(artifact.contentPath, { force: true });
    }
    this.repo.deleteById(id);
  }

  // ── countWarning ────────────────────────────────────────────────────────────

  countWarning(sessionId: SessionId): boolean {
    return this.repo.countBySession(sessionId) > SESSION_WARN_THRESHOLD;
  }

  // ── private helpers ──────────────────────────────────────────────────────────

  private fillContent(artifact: Artifact): Artifact {
    if (artifact.contentLocation !== 'file') return artifact;
    const filePath = artifact.contentPath;
    if (!filePath) return { ...artifact, content: '' };
    try {
      return { ...artifact, content: fs.readFileSync(filePath, 'utf8') };
    } catch {
      return { ...artifact, content: '' }; // file missing — degrade gracefully
    }
  }
}
