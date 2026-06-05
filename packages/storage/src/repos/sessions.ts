import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId, CharacterCardId } from '@ema-agent/contracts';

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
  last_mode:     string | null;
  last_sub_mode: string | null;
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

  /**
   * Cursor-based listing. Pass `cursor` from previous response's `nextCursor`.
   *
   * Cursor format: `"<pinned>.<updated_at>"` (opaque to client; encoded by
   * `nextCursorFor` below). This composite cursor is required because the
   * sort key is `(pinned DESC, updated_at DESC)` — a single-field cursor on
   * `updated_at` would skip items across the pinned/unpinned boundary when
   * a pinned item has an older timestamp than the last unpinned item shown.
   *
   * SQL keyset condition: "give me items strictly AFTER (lastPinned, lastTs)
   * in the sort order", which is:
   *   pinned < lastPinned   OR   (pinned = lastPinned AND updated_at < lastTs)
   */
  listActive(limit: number, cursor?: string): SessionRow[] {
    const parsed = parseCursor(cursor);
    if (parsed) {
      return this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE archived_at IS NULL
             AND (pinned < ? OR (pinned = ? AND updated_at < ?))
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(parsed.pinned, parsed.pinned, parsed.updatedAt, limit) as SessionRow[];
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

  /**
   * Replace the entire meta_json for a session. Callers are responsible for
   * reading the current meta first (via findById), merging their changes in JS,
   * then writing the merged object back here. This keeps the write path in
   * the repo without exposing raw SQL to callers.
   */
  setMeta(id: SessionId, meta: Record<string, unknown>): void {
    this.db
      .prepare('UPDATE sessions SET meta_json = ? WHERE id = ?')
      .run(JSON.stringify(meta), id);
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
   * Clone a session's messages into a new session row.
   *
   * Each copied message gets a fresh random ID so there are no primary-key
   * collisions. turn_id is set to NULL because turns belong to the source
   * session and cross-session turn references are dangling references.
   *
   * `untilTurnId` — when provided, only messages whose created_at is ≤ the
   * latest message in that turn are copied (branch-at-point semantics).
   *
   * Returns the number of messages copied.
   */
  forkInto(
    srcId:       SessionId,
    newId:       SessionId,
    title:       string,
    createdAt:   number,
    untilTurnId?: TurnId,
  ): number {
    const src = this.findById(srcId);
    if (!src) throw new Error(`Source session not found: ${srcId}`);

    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO sessions
           (id, title, character_card_id, workspace_roots_json,
            parent_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, title, src.character_card_id, src.workspace_roots_json,
        srcId, createdAt, createdAt);

      if (untilTurnId) {
        // Copy messages up to and including the last message of the cutoff turn.
        this.db.prepare(
          `INSERT INTO messages
             (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
           SELECT lower(hex(randomblob(16))), ?, NULL,
                  role, kind, blocks_json, interrupted, created_at, meta_json
           FROM messages
           WHERE session_id = ?
             AND created_at <= (
               SELECT COALESCE(MAX(created_at), 0)
               FROM messages
               WHERE turn_id = ?
             )
           ORDER BY created_at ASC`,
        ).run(newId, srcId, untilTurnId);
      } else {
        // Copy all messages with new IDs; null out turn_id (turns stay in source).
        this.db.prepare(
          `INSERT INTO messages
             (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
           SELECT lower(hex(randomblob(16))), ?, NULL,
                  role, kind, blocks_json, interrupted, created_at, meta_json
           FROM messages
           WHERE session_id = ?
           ORDER BY created_at ASC`,
        ).run(newId, srcId);
      }
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


  // ── Patch (transactional partial update) ───────────────────────────────────

  /**
   * Apply a partial update atomically. Used by `PUT /api/sessions/:id` where
   * the client can change `title` + `pinned` + `groupLabel` in one request.
   *
   * All sub-updates run inside a single SQLite transaction; any failure rolls
   * back the whole patch so the row never sits in a half-changed state.
   *
   * `groupLabel === null` is the explicit "move out of group" signal; the
   * caller must distinguish that from `undefined` (don't touch).
   */
  patch(
    id: SessionId,
    patch: {
      title?:          string;
      pinned?:         boolean;
      groupLabel?:     string | null;
      workspaceRoots?: string[];
      lastMode?:       string | null;
      lastSubMode?:    string | null;
    },
    now: number,
  ): void {
    const setClauses: string[] = [];
    const values:     unknown[] = [];

    if (patch.title !== undefined) {
      setClauses.push('title = ?');
      values.push(patch.title);
    }
    if (patch.pinned === true) {
      setClauses.push('pinned = 1', 'pinned_at = ?');
      values.push(now);
    } else if (patch.pinned === false) {
      setClauses.push('pinned = 0', 'pinned_at = NULL');
    }
    if (patch.groupLabel !== undefined) {
      setClauses.push('group_label = ?');
      values.push(patch.groupLabel);
    }
    if (patch.workspaceRoots !== undefined) {
      setClauses.push('workspace_roots_json = ?');
      values.push(JSON.stringify(patch.workspaceRoots));
    }
    if (patch.lastMode !== undefined) {
      setClauses.push('last_mode = ?');
      values.push(patch.lastMode);
    }
    if (patch.lastSubMode !== undefined) {
      setClauses.push('last_sub_mode = ?');
      values.push(patch.lastSubMode);
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(now);
    values.push(id);

    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...values);
    })();
  }
}

// ── Cursor helpers ──────────────────────────────────────────────────────────

interface ParsedCursor {
  pinned:    number;     // 0 | 1
  updatedAt: number;
}

/**
 * Parse the opaque cursor string `"<pinned>.<updatedAt>"`. Returns `null`
 * when the cursor is absent or malformed (callers fall back to "first page").
 *
 * @example parseCursor("1.1700000000")  // { pinned: 1, updatedAt: 1700000000 }
 * @example parseCursor(undefined)       // null
 */
function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (!cursor) return null;
  const [pinnedStr, tsStr] = cursor.split('.');
  if (pinnedStr === undefined || tsStr === undefined) return null;
  const pinned    = parseInt(pinnedStr, 10);
  const updatedAt = parseInt(tsStr, 10);
  if (!Number.isFinite(pinned) || !Number.isFinite(updatedAt)) return null;
  if (pinned !== 0 && pinned !== 1) return null;
  return { pinned, updatedAt };
}

/**
 * Build a cursor from a session row. Pass the LAST row of the current page;
 * the next page query will use this to keyset-skip into the right spot.
 */
export function nextCursorFor(row: SessionRow): string {
  return `${row.pinned}.${row.updated_at}`;
}
