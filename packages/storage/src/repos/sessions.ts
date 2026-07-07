import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId, CharacterCardId, BranchId } from '@ema-agent/contracts';

export interface SessionRow {
  id: string;
  title: string;
  character_card_id: string;
  workspace_root:     string | null;
  created_at: number;
  /** Row metadata update time: title/group/pin/workspace/mode/meta edits. Not used for recent-session ordering. */
  updated_at: number;
  /** Conversation activity time: advanced when a new turn/message starts. Used for recent-session ordering. */
  last_activity_at: number;
  archived_at: number | null;
  pinned:        number;        // 0 | 1
  pinned_at:     number | null;
  group_label:   string | null;
  parent_session_id: string | null;
  last_mode:        string | null;
  last_viewed_at:   number | null;
  active_branch_id: string | null;
}

/** SessionRow with derived turn fields from a JOIN query. */
export interface SessionRowEnriched extends SessionRow {
  last_turn_status:       string | null;
  last_turn_completed_at: number | null;
}

export interface SessionSearchRow extends SessionRowEnriched {
  match_kind:         'title' | 'message';
  snippet_json:       string | null;
  message_id:         string | null;
  message_created_at: number | null;
}

export interface SessionInsert {
  id: SessionId;
  title: string;
  characterCardId: CharacterCardId;
  workspaceRoot?:  string | null;
  parentSessionId?: string;
  lastMode?:        string | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
}

export interface SessionsGrouped {
  pinned:   SessionRowEnriched[];
  byGroup:  Array<{ label: string; sessions: SessionRowEnriched[] }>;
  recent:   SessionRowEnriched[];
  archived: SessionRowEnriched[];
}

export class SessionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(s: SessionInsert): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, title, character_card_id, workspace_root,
            parent_session_id, last_mode, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.characterCardId,
        s.workspaceRoot ?? null,
        s.parentSessionId ?? null, s.lastMode ?? null, s.createdAt, s.updatedAt,
        s.lastActivityAt ?? s.createdAt);
  }

  findById(id: SessionId): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  /**
   * Cursor-based listing. Pass `cursor` from previous response's `nextCursor`.
   *
   * Cursor format: `"<pinned>.<last_activity_at>"` (opaque to client; encoded by
   * `nextCursorFor` below). This composite cursor is required because the
   * sort key is `(pinned DESC, last_activity_at DESC)` — a single-field cursor on
   * `last_activity_at` would skip items across the pinned/unpinned boundary when
   * a pinned item has an older timestamp than the last unpinned item shown.
   *
   * SQL keyset condition: "give me items strictly AFTER (lastPinned, lastTs)
   * in the sort order", which is:
   *   pinned < lastPinned   OR   (pinned = lastPinned AND last_activity_at < lastTs)
   */
  listActive(limit: number, cursor?: string): SessionRow[] {
    const parsed = parseCursor(cursor);
    if (parsed) {
      return this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE archived_at IS NULL
             AND (pinned < ? OR (pinned = ? AND last_activity_at < ?))
           ORDER BY pinned DESC, last_activity_at DESC
           LIMIT ?`,
        )
        .all(parsed.pinned, parsed.pinned, parsed.lastActivityAt, limit) as SessionRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE archived_at IS NULL
         ORDER BY pinned DESC, last_activity_at DESC
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
  listGrouped(): { pinned: SessionRowEnriched[]; byGroup: Array<{ label: string; sessions: SessionRowEnriched[] }>; recent: SessionRowEnriched[]; archived: SessionRowEnriched[] } {
    const all = this.db
      .prepare(`
        SELECT s.*,
          (SELECT t.status FROM turns t WHERE t.session_id = s.id ORDER BY t.started_at DESC LIMIT 1) AS last_turn_status,
          (SELECT t.completed_at FROM turns t WHERE t.session_id = s.id ORDER BY t.started_at DESC LIMIT 1) AS last_turn_completed_at
        FROM sessions s
        ORDER BY s.pinned DESC, s.last_activity_at DESC
      `)
      .all() as SessionRowEnriched[];

    const groupedMap = new Map<string, SessionRowEnriched[]>();
    const pinned:   SessionRowEnriched[] = [];
    const recent:   SessionRowEnriched[] = [];
    const archived: SessionRowEnriched[] = [];

    for (const s of all) {
      if (s.archived_at) { archived.push(s); continue; }

      // Grouped sessions include BOTH pinned and non-pinned — frontend sorts
      // pinned-first within each group visual section.
      if (s.group_label) {
        const list = groupedMap.get(s.group_label) ?? ([] as SessionRowEnriched[]);
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

  search(query: string, limit: number): SessionSearchRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const pattern = `%${q}%`;

    return this.db
      .prepare(`
        SELECT s.*,
          (SELECT t.status FROM turns t WHERE t.session_id = s.id ORDER BY t.started_at DESC LIMIT 1) AS last_turn_status,
          (SELECT t.completed_at FROM turns t WHERE t.session_id = s.id ORDER BY t.started_at DESC LIMIT 1) AS last_turn_completed_at,
          CASE
            WHEN lower(s.title) LIKE ? THEN 'title'
            ELSE 'message'
          END AS match_kind,
          CASE
            WHEN lower(s.title) LIKE ? THEN s.title
            ELSE (
              SELECT m.blocks_json
                FROM messages m
               WHERE m.session_id = s.id
                 AND m.kind IN ('normal', 'summary')
                 AND lower(m.blocks_json) LIKE ?
               ORDER BY m.created_at DESC
               LIMIT 1
            )
          END AS snippet_json,
          (
            SELECT m.id
              FROM messages m
             WHERE m.session_id = s.id
               AND m.kind IN ('normal', 'summary')
               AND lower(m.blocks_json) LIKE ?
             ORDER BY m.created_at DESC
             LIMIT 1
          ) AS message_id,
          (
            SELECT m.created_at
              FROM messages m
             WHERE m.session_id = s.id
               AND m.kind IN ('normal', 'summary')
               AND lower(m.blocks_json) LIKE ?
             ORDER BY m.created_at DESC
             LIMIT 1
          ) AS message_created_at
        FROM sessions s
        WHERE s.archived_at IS NULL
          AND (
            lower(s.title) LIKE ?
            OR EXISTS (
              SELECT 1
                FROM messages m
               WHERE m.session_id = s.id
                 AND m.kind IN ('normal', 'summary')
                 AND lower(m.blocks_json) LIKE ?
            )
          )
        ORDER BY s.pinned DESC, s.last_activity_at DESC
        LIMIT ?
      `)
      .all(pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit) as SessionSearchRow[];
  }

  setViewedAt(id: SessionId, now: number): void {
    this.db
      .prepare('UPDATE sessions SET last_viewed_at = ? WHERE id = ?')
      .run(now, id);
  }

  updateTitle(id: SessionId, title: string, updatedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, updatedAt, id);
  }

  touchActivity(id: SessionId, at: number): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?')
      .run(at, at, id);
  }

  // ── Pin / Unpin ───────────────────────────────────────────────────────────

  pin(id: SessionId, pinnedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET pinned = 1, pinned_at = ?, updated_at = ? WHERE id = ?')
      .run(pinnedAt, pinnedAt, id);
  }

  unpin(id: SessionId): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE sessions SET pinned = 0, pinned_at = NULL, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  // ── Group ──────────────────────────────────────────────────────────────────

  setGroup(id: SessionId, label: string | null): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE sessions SET group_label = ?, updated_at = ? WHERE id = ?')
      .run(label, now, id);
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
      // 1. New session row — copy character_card_id + workspace_root + last_mode,
      //    parent_session_id points back to src (provenance). New session starts
      //    flat (no branches, active_branch_id NULL).
      this.db.prepare(
        `INSERT INTO sessions
           (id, title, character_card_id, workspace_root,
            parent_session_id, last_mode, created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, title, src.character_card_id, src.workspace_root,
        srcId, src.last_mode, createdAt, createdAt, createdAt);

      // 2. Build old→new turn id map. Turns are copied so the forked session
      //    retains mode / status / usage / timing — without them, the frontend
      //    loses token stats, mode chip, TTS replay button, and tool_result
      //    grouping. branch_id is cleared (new session is flat).
      this.db.prepare('CREATE TEMP TABLE _turn_id_map (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL)').run();

      const untilStartedAt = untilTurnId
        ? (this.db.prepare('SELECT started_at FROM turns WHERE id = ?').get(untilTurnId) as { started_at: number } | undefined)?.started_at
        : undefined;

      this.db.prepare(
        untilStartedAt !== undefined
          ? `INSERT INTO _turn_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM turns
             WHERE session_id = ? AND started_at <= ?`
          : `INSERT INTO _turn_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM turns WHERE session_id = ?`,
      ).run(srcId, ...(untilStartedAt !== undefined ? [untilStartedAt] : []));

      // 3. Copy turns with fresh ids, branch_id = NULL.
      this.db.prepare(
        `INSERT INTO turns
           (id, session_id, mode, branch_id, status, user_input, started_at, completed_at,
            error_code, error_message, iterations, usage_input_tokens, usage_output_tokens, meta_json)
         SELECT m.new_id, ?, t.mode, NULL, t.status, t.user_input, t.started_at, t.completed_at,
                t.error_code, t.error_message, t.iterations,
                t.usage_input_tokens, t.usage_output_tokens, t.meta_json
         FROM turns t JOIN _turn_id_map m ON m.old_id = t.id
         ORDER BY t.started_at ASC`,
      ).run(newId);

      // 4. Copy messages — fresh ids, turn_id remapped via the temp map (NULL
      //    for messages with no turn). Cutoff aligns with the original: messages
      //    up to and including the last message of the cutoff turn.
      const msgCutoff = untilTurnId
        ? (this.db.prepare('SELECT COALESCE(MAX(created_at), 0) AS m FROM messages WHERE turn_id = ?').get(untilTurnId) as { m: number }).m
        : undefined;

      this.db.prepare(
        msgCutoff !== undefined
          ? `INSERT INTO messages
               (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
             SELECT lower(hex(randomblob(16))), ?,
                    (SELECT m.new_id FROM _turn_id_map m WHERE m.old_id = messages.turn_id),
                    role, kind, blocks_json, interrupted, created_at, meta_json
             FROM messages
             WHERE session_id = ? AND created_at <= ?
             ORDER BY created_at ASC`
          : `INSERT INTO messages
               (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
             SELECT lower(hex(randomblob(16))), ?,
                    (SELECT m.new_id FROM _turn_id_map m WHERE m.old_id = messages.turn_id),
                    role, kind, blocks_json, interrupted, created_at, meta_json
             FROM messages
             WHERE session_id = ?
             ORDER BY created_at ASC`,
      ).run(newId, srcId, ...(msgCutoff !== undefined ? [msgCutoff] : []));

      // 5. Copy turn_attachments — fresh ids, turn_id remapped, session_id = new.
      //    Without this, user-message attachment chips disappear in the fork
      //    (attachmentStore.listByTurn(newTurnId) would be empty).
      this.db.prepare(
        `INSERT INTO turn_attachments
           (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
         SELECT lower(hex(randomblob(16))), m.new_id, ?, ta.name, ta.mime, ta.size, ta.mtime, ta.local_path, ta.created_at
         FROM turn_attachments ta
         JOIN _turn_id_map m ON m.old_id = ta.turn_id`,
      ).run(newId);

      this.db.prepare('DROP TABLE _turn_id_map').run();
    })();

    const count = this.db
      .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
      .get(newId) as { cnt: number };
    return count.cnt;
  }

  // ── Branch ────────────────────────────────────────────────────────────────

  setActiveBranch(id: SessionId, branchId: BranchId | null): void {
    this.db
      .prepare('UPDATE sessions SET active_branch_id = ?, updated_at = ? WHERE id = ?')
      .run(branchId, Date.now(), id);
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
      workspaceRoot?:  string | null;
      lastMode?:       string | null;
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
    if (patch.workspaceRoot !== undefined) {
      setClauses.push('workspace_root = ?');
      values.push(patch.workspaceRoot);
    }
    if (patch.lastMode !== undefined) {
      setClauses.push('last_mode = ?');
      values.push(patch.lastMode);
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
  lastActivityAt: number;
}

/**
 * Parse the opaque cursor string `"<pinned>.<lastActivityAt>"`. Returns `null`
 * when the cursor is absent or malformed (callers fall back to "first page").
 *
 * @example parseCursor("1.1700000000")  // { pinned: 1, lastActivityAt: 1700000000 }
 * @example parseCursor(undefined)       // null
 */
function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (!cursor) return null;
  const [pinnedStr, tsStr] = cursor.split('.');
  if (pinnedStr === undefined || tsStr === undefined) return null;
  const pinned    = parseInt(pinnedStr, 10);
  const lastActivityAt = parseInt(tsStr, 10);
  if (!Number.isFinite(pinned) || !Number.isFinite(lastActivityAt)) return null;
  if (pinned !== 0 && pinned !== 1) return null;
  return { pinned, lastActivityAt };
}

/**
 * Build a cursor from a session row. Pass the LAST row of the current page;
 * the next page query will use this to keyset-skip into the right spot.
 */
export function nextCursorFor(row: SessionRow): string {
  return `${row.pinned}.${row.last_activity_at}`;
}
