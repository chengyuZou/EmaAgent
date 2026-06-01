import type { SqliteDb } from '../database.js';
import type { ArtifactId, SessionId, TurnId, ArtifactType } from '@ema-agent/contracts';
import type { Artifact } from '@ema-agent/contracts';

// ── DB row 原始结构 ───────────────────────────────────────────────────────────
interface ArtifactRow {
  id:               string;
  session_id:       string;
  turn_id:          string | null;
  type:             string;
  title:            string;
  content:          string;
  content_location: string;
  content_path:     string | null;
  meta_json:        string;
  applied_at:       number | null;
  rejected_at:      number | null;
  created_at:       number;
  updated_at:       number;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id:              row.id              as ArtifactId,
    sessionId:       row.session_id      as SessionId,
    turnId:          row.turn_id         ? (row.turn_id as TurnId) : undefined,
    type:            row.type            as ArtifactType,
    title:           row.title,
    content:         row.content,                           // file 时是 ''，Store 负责填
    contentLocation: row.content_location as 'inline' | 'file',
    contentPath:     row.content_path    ?? undefined,
    meta:            JSON.parse(row.meta_json) as Record<string, unknown>,
    appliedAt:       row.applied_at      ?? undefined,
    rejectedAt:      row.rejected_at     ?? undefined,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  };
}

// camelCase patch 键 → DB 列名（明确映射，不用 regex）
const PATCH_COL: Record<string, string> = {
  content:         'content',
  contentLocation: 'content_location',
  contentPath:     'content_path',
  title:           'title',
  type:            'type',
  meta:            'meta_json',       // ← regex 转不出这个
  appliedAt:       'applied_at',
  rejectedAt:      'rejected_at',
  updatedAt:       'updated_at',
};

export class ArtifactRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(artifact: Artifact): void {
    this.db.prepare(`
      INSERT INTO artifacts
        (id, session_id, turn_id, type, title, content, content_location,
         content_path, meta_json, created_at, updated_at, applied_at, rejected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.sessionId,
      artifact.turnId      ?? null,
      artifact.type,
      artifact.title,
      artifact.content,
      artifact.contentLocation,
      artifact.contentPath ?? null,
      JSON.stringify(artifact.meta),
      artifact.createdAt,
      artifact.updatedAt,
      artifact.appliedAt   ?? null,
      artifact.rejectedAt  ?? null,
    );
  }

  update(id: ArtifactId, patch: Partial<Pick<
    Artifact,
    'content' | 'contentLocation' | 'contentPath' | 'title' |
    'type' | 'meta' | 'appliedAt' | 'rejectedAt' | 'updatedAt'
  >>): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    for (const [key, val] of Object.entries(patch)) {
      if (val === undefined) continue;
      const col = PATCH_COL[key];
      if (!col) continue;
      cols.push(`${col} = ?`);
      values.push(key === 'meta' ? JSON.stringify(val) : val);
    }

    if (cols.length === 0) return;
    values.push(id);

    this.db.prepare(`
      UPDATE artifacts SET ${cols.join(', ')} WHERE id = ?
    `).run(...values);
  }

  findById(id: ArtifactId): Artifact | null {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(id) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listBySession(
    sessionId: SessionId,
    opts?: { type?: string; includeContent?: boolean },
  ): Omit<Artifact, 'content'>[] {
    const rows = (opts?.type
      ? this.db.prepare(
          `SELECT * FROM artifacts WHERE session_id = ? AND type = ? ORDER BY created_at ASC`,
        ).all(sessionId, opts.type)
      : this.db.prepare(
          `SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC`,
        ).all(sessionId)
    ) as ArtifactRow[];

    return rows.map((row) => {
      const artifact = rowToArtifact(row);
      if (!opts?.includeContent) {
        // content 不返回给列表调用方，减少序列化开销
        const { content: _, ...rest } = artifact;
        return rest;
      }
      return artifact;
    });
  }

  deleteById(id: ArtifactId): void {
    this.db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
  }

  countBySession(sessionId: SessionId): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM artifacts WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return row.n;
  }
}