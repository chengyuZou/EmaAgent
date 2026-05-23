import type { SqliteDb } from '../database.js';
import type { SessionId, CharacterCardId } from '@ema-agent/contracts';

export interface SessionRow {
  id: string;
  title: string;
  character_card_id: string;
  workspace_roots_json: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  pinned:        number;        // 0 | 1
  pinned_at:     number | null;
  group_label:   string | null;
  parent_session_id: string | null;
  meta_json: string;
  pending_fragments_json: string;
}

export interface SessionInsert {
  id: SessionId;
  title: string;
  characterCardId: CharacterCardId;
  workspaceRoots?: string[];
  parentSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionsGrouped {
  pinned:   SessionRow[];
  byGroup:  Array<{ label: string; sessions: SessionRow[] }>;
  recent:   SessionRow[];
  archived: SessionRow[];
}

export class SessionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(s: SessionInsert): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, title, character_card_id, workspace_roots_json,
            parent_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.characterCardId,
        JSON.stringify(s.workspaceRoots ?? []),
        s.parentSessionId ?? null, s.createdAt, s.updatedAt);
  }

  findById(id: SessionId): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  /** Cursor-based listing. Pass `cursor` from previous response's `nextCursor`. */
  listActive(limit: number, cursor?: number): SessionRow[] {
    if (cursor != null) {
      return this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE archived_at IS NULL AND updated_at < ?
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(cursor, limit) as SessionRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE archived_at IS NULL
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as SessionRow[];
  }

  /**
   * Grouped listing for the sidebar UI:
   *   pinned   — pinned sessions (most-recent-updated first)
   *   byGroup  — sessions WITH a group_label, grouped by label
   *   recent   — unpinned, ungrouped, active sessions
   *   archived — soft-deleted sessions
   */
  /**
   * Sidebar layout:
   *   byGroup  — sessions WITH group_label, pinned-first within each group
   *   pinned   — sessions pinned but WITHOUT group_label
   *   recent   — everything else (non-archived, non-pinned, no group)
   *   archived — soft-deleted
   *
   * Fold/unfold is purely a frontend concern — backend returns flat buckets.
   */
  listGrouped(): SessionsGrouped {
    const all = this.db
      .prepare('SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC')
      .all() as SessionRow[];

    const groupedMap = new Map<string, SessionRow[]>();
    const pinned:   SessionRow[] = [];
    const recent:   SessionRow[] = [];
    const archived: SessionRow[] = [];

    for (const s of all) {
      if (s.archived_at) { archived.push(s); continue; }

      // Grouped sessions include BOTH pinned and non-pinned — frontend sorts
      // pinned-first within each group visual section.
      if (s.group_label) {
        const list = groupedMap.get(s.group_label) ?? [];
        list.push(s);
        groupedMap.set(s.group_label, list);
        continue;
      }

      // Ungrouped
      if (s.pinned) { pinned.push(s); continue; }
      recent.push(s);
    }

    return {
      pinned,
      byGroup: [...groupedMap.entries()].map(([label, sessions]) => ({ label, sessions })),
      recent,
      archived,
    };
  }

  updateTitle(id: SessionId, title: string, updatedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, updatedAt, id);
  }

  touch(id: SessionId, updatedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(updatedAt, id);
  }

  // ── Pin / Unpin ───────────────────────────────────────────────────────────

  pin(id: SessionId, pinnedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET pinned = 1, pinned_at = ? WHERE id = ?')
      .run(pinnedAt, id);
  }

  unpin(id: SessionId): void {
    this.db
      .prepare('UPDATE sessions SET pinned = 0, pinned_at = NULL WHERE id = ?')
      .run(id);
  }

  // ── Group ──────────────────────────────────────────────────────────────────

  setGroup(id: SessionId, label: string | null): void {
    this.db
      .prepare('UPDATE sessions SET group_label = ? WHERE id = ?')
      .run(label, id);
  }

  // ── Archive / Unarchive ────────────────────────────────────────────────────

  archive(id: SessionId, archivedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archivedAt, archivedAt, id);
  }

  unarchive(id: SessionId): void {
    this.db
      .prepare('UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  // ── Fork ───────────────────────────────────────────────────────────────────

  /**
   * Clone a session's messages (NOT turns) into a new session row.
   * Returns the number of messages copied.
   */
  forkInto(srcId: SessionId, newId: SessionId, title: string, createdAt: number): number {
    const src = this.findById(srcId);
    if (!src) throw new Error(`Source session not found: ${srcId}`);

    this.db.transaction(() => {
      // Insert the new session row
      this.db.prepare(
        `INSERT INTO sessions
           (id, title, character_card_id, workspace_roots_json,
            parent_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, title, src.character_card_id, src.workspace_roots_json,
        srcId, createdAt, createdAt);

      // Copy messages (keep original timestamps + ordering)
      this.db.prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
         SELECT id, ?, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json
         FROM messages WHERE session_id = ?`,
      ).run(newId, srcId);
    })();

    const count = this.db
      .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
      .get(newId) as { cnt: number };
    return count.cnt;
  }

  // ── Running turn count ─────────────────────────────────────────────────────

  /** How many turns are currently running for this session. */
  runningTurnCount(id: SessionId): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM turns WHERE session_id = ? AND status = 'running'")
      .get(id) as { cnt: number };
    return row.cnt;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  delete(id: SessionId): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ── pending_fragments_json ──────────────────────────────────────────────────

  getPendingFragmentsRaw(id: SessionId): string {
    const row = this.db
      .prepare('SELECT pending_fragments_json FROM sessions WHERE id = ?')
      .get(id) as { pending_fragments_json: string } | undefined;
    return row?.pending_fragments_json ?? '[]';
  }

  setPendingFragmentsRaw(id: SessionId, json: string, updatedAt: number): void {
    this.db
      .prepare(
        'UPDATE sessions SET pending_fragments_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(json, updatedAt, id);
  }

  clearPendingFragments(id: SessionId, updatedAt: number): void {
    this.setPendingFragmentsRaw(id, '[]', updatedAt);
  }

  listSessionsWithPending(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM sessions WHERE pending_fragments_json IS NOT NULL
           AND pending_fragments_json != '[]'`,
      )
      .all() as Array<{ id: string }>;
    return rows.map(r => r.id);
  }
}
