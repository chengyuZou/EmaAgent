// 读写 Session 行、稳定分页、搜索投影、项目分组投影、Fork 和事务性偏好更新。
// Row 枚举由 storage 自持（SQL CHECK 的映射）；领域词汇归 @ema-agent/turn-terms 叶子，业务包在边界显式映射。
import type { SqliteDb } from '../../database/database.js';
import type { TurnStatusRow } from './turns.js';
import { buildFtsQuery } from '../../search/zh-tokenizer.js';
import { escapeLikePattern } from '../../search/like-utils.js';

/** sessions/turns 行上的 Chat/Work 模式（SQL CHECK 原样）。 */
export type SessionModeRow = 'chat' | 'work';
/** sessions/turns 行上的剧情策略枚举（SQL CHECK 原样）。 */
export type NarrativePolicyRow = 'auto' | 'always' | 'off';
export type PermissionModeRow = 'default' | 'acceptEdits' | 'bypassPermissions';
export type ReasoningEffortRow = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface SessionRow {
  id: string;
  title: string;
  cwd:     string;
  /** 项目成员资格；cwd 不随项目文件夹变化自动改写。 */
  project_id:         string | null;
  created_at: number;
  /** 行元数据更新时间：标题、置顶、cwd 或 Profile 编辑。不用于 UI 侧栏排序。 */
  updated_at: number;
  /** 对话活动时间:新 Turn 开始时推进，用于时间展示与未读判断。 */
  last_activity_at: number;
  /** 侧栏内的显式顺序；拖放与新 Turn 开始会推进它。 */
  sidebar_order: number;
  archived_at: number | null;
  pinned:        number;        // 0 | 1
  /** fork 溯源：来源 Session 与截断点 Turn（完整复制时截断点为 null）。 */
  forked_from_session_id: string | null;
  forked_from_turn_id:    string | null;
  session_mode: SessionModeRow;
  narrative_policy: NarrativePolicyRow;
  permission_mode: PermissionModeRow;
  tts_enabled: number;
  /** null 表示尚未选模型, 不能开始 Turn. */
  provider_id: string | null;
  /** 与 provider_id 成对保存; null 时不能开始 Turn. */
  model_id: string | null;
  reasoning_effort: ReasoningEffortRow;
  last_viewed_at:   number | null;
}

/** SessionRow 带 JOIN 查询派生的 turn 字段。 */
export interface SessionRowEnriched extends SessionRow {
  last_turn_status:       TurnStatusRow | null;
  last_turn_completed_at: number | null;
  has_active_turn:       number;
}

/** SessionRow 带 JOIN 查询派生的 turn 字段 + 搜索匹配字段 用于查找 session标题/session内Message */
export interface SessionSearchRow extends SessionRowEnriched {
  match_kind:         'title' | 'message';
  snippet_text:       string | null;
  message_id:         string | null;
  message_created_at: number | null;
}

export interface SessionInsert {
  id: string;
  title: string;
  cwd:  string;
  projectId?: string | null;
  forkedFromSessionId?: string;
  forkedFromTurnId?: string | null;
  sessionMode?: SessionModeRow;
  narrativePolicy?: NarrativePolicyRow;
  permissionMode?: PermissionModeRow;
  ttsEnabled?: boolean;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffortRow;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
}

export class SessionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(s: SessionInsert): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, title, cwd, project_id,
            forked_from_session_id, forked_from_turn_id,
            session_mode, narrative_policy, permission_mode, tts_enabled,
            provider_id, model_id, reasoning_effort,
            created_at, updated_at, last_activity_at, sidebar_order)
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(sidebar_order), 0) + 1
              FROM sessions
             WHERE archived_at IS NULL
               AND pinned = 0
               AND project_id IS ?)
         )`,
      )
      .run(s.id, s.title,
        s.cwd,
        s.projectId ?? null,
        s.forkedFromSessionId ?? null,
        s.forkedFromTurnId ?? null,
        s.sessionMode ?? 'chat',
        s.narrativePolicy ?? 'auto',
        s.permissionMode ?? 'default',
        s.ttsEnabled ? 1 : 0,
        s.providerId ?? null,
        s.modelId ?? null,
        s.reasoningEffort ?? 'off',
        s.createdAt, s.updatedAt,
        s.lastActivityAt ?? s.createdAt,
        s.projectId ?? null);
  }

  findById(id: string): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  /**
   * 侧栏四区用的全量 enriched 行（含 archived），分桶由业务层按 project_id 实体完成。
   */
  listEnrichedAll(): SessionRowEnriched[] {
    return this.db
      .prepare(`
        WITH latest_turn AS (
          SELECT
            t.session_id,
            t.status,
            t.completed_at,
            ROW_NUMBER() OVER (
              PARTITION BY t.session_id
              ORDER BY t.created_at DESC, t.id DESC
            ) AS row_number
          FROM turns t
        ),
        running_turns AS (
          SELECT session_id, 1 AS has_active_turn
          FROM turns
          WHERE status = 'running'
          GROUP BY session_id
        )
        SELECT
          s.*,
          lt.status AS last_turn_status,
          lt.completed_at AS last_turn_completed_at,
          COALESCE(rt.has_active_turn, 0) AS has_active_turn
        FROM sessions s
        LEFT JOIN latest_turn lt
          ON lt.session_id = s.id
         AND lt.row_number = 1
        LEFT JOIN running_turns rt ON rt.session_id = s.id
        ORDER BY
          CASE WHEN s.archived_at IS NULL THEN s.pinned ELSE 0 END DESC,
          s.sidebar_order DESC,
          s.last_activity_at DESC,
          s.id DESC
      `)
      .all() as SessionRowEnriched[];
  }

  // ── 项目成员资格 ────────────────────────────────────────────────────────────

  /** 拖入项目只改变成员资格。 */
  assignToProject(id: string, projectId: string, now: number): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?')
        .run(projectId, now, id);
      this.moveToTop(id);
    })();
  }

  /** 拖出项目：只解除成员资格，cwd 保留原值恢复自由。 */
  removeFromProject(id: string, now: number): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE sessions SET project_id = NULL, updated_at = ? WHERE id = ?')
        .run(now, id);
      this.moveToTop(id);
    })();
  }

  search(query: string, limit: number): SessionSearchRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const pattern = `%${escapeLikePattern(q)}%`;
    const ftsQuery = buildFtsQuery(q) ?? '"__ema_no_search_terms__"';

    return this.db
      .prepare(`
        WITH latest_turn AS (
          SELECT
            t.session_id,
            t.status,
            t.completed_at,
            ROW_NUMBER() OVER (
              PARTITION BY t.session_id
              ORDER BY t.created_at DESC, t.id DESC
            ) AS row_number
          FROM turns t
        ),
        running_turns AS (
          SELECT session_id, 1 AS has_active_turn
          FROM turns
          WHERE status = 'running'
          GROUP BY session_id
        ),
        matched_message AS (
          SELECT
            d.session_id,
            d.message_id AS id,
            substr(d.text, 1, 220) AS snippet_text,
            d.created_at,
            ROW_NUMBER() OVER (
              PARTITION BY d.session_id
              ORDER BY d.created_at DESC, d.message_id DESC
            ) AS row_number
          FROM message_search_fts fts
          JOIN message_search_documents d ON d.message_id = fts.message_id
          WHERE message_search_fts MATCH ?
        )
        SELECT
          s.*,
          lt.status AS last_turn_status,
          lt.completed_at AS last_turn_completed_at,
          COALESCE(rt.has_active_turn, 0) AS has_active_turn,
          CASE
            WHEN lower(s.title) LIKE ? ESCAPE '\\' THEN 'title'
            ELSE 'message'
          END AS match_kind,
          CASE
            WHEN lower(s.title) LIKE ? ESCAPE '\\' THEN s.title
            ELSE mm.snippet_text
          END AS snippet_text,
          mm.id AS message_id,
          mm.created_at AS message_created_at
        FROM sessions s
        LEFT JOIN latest_turn lt
          ON lt.session_id = s.id
         AND lt.row_number = 1
        LEFT JOIN running_turns rt ON rt.session_id = s.id
        LEFT JOIN matched_message mm
          ON mm.session_id = s.id
         AND mm.row_number = 1
        WHERE s.archived_at IS NULL
          AND (
            lower(s.title) LIKE ? ESCAPE '\\'
            OR mm.id IS NOT NULL
          )
        ORDER BY s.pinned DESC, s.last_activity_at DESC, s.id DESC
        LIMIT ?
      `)
      .all(ftsQuery, pattern, pattern, pattern, limit) as SessionSearchRow[];
  }

  setViewedAt(id: string, now: number): void {
    this.db
      .prepare('UPDATE sessions SET last_viewed_at = ? WHERE id = ?')
      .run(now, id);
  }

  updateTitle(id: string, title: string, updatedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, updatedAt, id);
  }

  /** 自动标题的条件写入：仅当前标题仍是默认值才覆盖；返回是否写入（0 = 用户已改名或行不存在）。 */
  updateTitleIfDefault(id: string, title: string, defaultTitle: string, updatedAt: number): boolean {
    return this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ?')
      .run(title, updatedAt, id, defaultTitle).changes === 1;
  }

  touchActivity(id: string, at: number): void {
    this.db.transaction(() => {
      const result = this.db
        .prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?')
        .run(at, at, id);
      if (result.changes === 0) throw new Error(`session_not_found: ${id}`);
      this.moveToTop(id);
    })();
  }

  // ── 置顶 / 取消置顶 ────────────────────────────────────────────────────────

  pin(id: string, now: number): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE sessions SET pinned = 1, updated_at = ? WHERE id = ?')
        .run(now, id);
      this.moveToTop(id);
    })();
  }

  unpin(id: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE sessions SET pinned = 0, updated_at = ? WHERE id = ?')
        .run(now, id);
      this.moveToTop(id);
    })();
  }

  // ── 归档 / 取消归档 ────────────────────────────────────────────────────────────

  archive(id: string, archivedAt: number): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
        .run(archivedAt, archivedAt, id);
      this.moveToTop(id);
    })();
  }

  unarchive(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?')
        .run(Date.now(), id);
      this.moveToTop(id);
    })();
  }

  moveInSidebar(
    id: string,
    pinned: boolean,
    projectId: string | null,
    beforeSessionId: string | null,
    now: number,
  ): void {
    this.db.transaction(() => {
      const current = this.findById(id);
      if (!current) throw new Error(`session_not_found: ${id}`);
      if (current.archived_at !== null) throw new Error(`session_archived: ${id}`);

      const membershipChanged = current.pinned !== (pinned ? 1 : 0)
        || current.project_id !== projectId;
      this.db.prepare(`
        UPDATE sessions
           SET pinned = ?, project_id = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END
         WHERE id = ?
      `).run(pinned ? 1 : 0, projectId, membershipChanged ? 1 : 0, now, id);

      const { sql, params } = activeBucketWhere(pinned, projectId);
      const orderedIds = this.db
        .prepare(`SELECT id FROM sessions WHERE ${sql} AND id <> ? ORDER BY sidebar_order DESC, id DESC`)
        .pluck()
        .all(...params, id) as string[];
      insertSessionBefore(orderedIds, id, beforeSessionId);
      this.writeOrder(orderedIds);
    })();
  }

  // ── Fork ──────────────────────────────────────────────────────────────────────

  /**
   * 把一个 Session 的 Turn、Message 和 Attachment 克隆为独立 Session。
   *
   * 所有实体重新生成 ID，Message 与 Attachment 通过临时映射表指向新 Turn。
   * `untilTurnId` 提供时只复制到该 Turn（含）为止并记为 forked_from_turn_id，
   * 不能把同毫秒的后续 Turn 或无归属消息误带进新 Session。
   *
   * 返回复制的 message 数量。
   */
  forkInto(
    srcId:       string,
    newId:       string,
    title:       string,
    createdAt:   number,
    untilTurnId?: string,
  ): number {
    const src = this.findById(srcId);
    if (!src) throw new Error(`Source session not found: ${srcId}`);

    this.db.transaction(() => {
      // 1. 新 Session 行复制 Workspace、项目成员、执行偏好和当前模型选择。
      //    forked_from_* 指回来源 Session 与截断 Turn，用于 Fork 溯源。
      this.db.prepare(
        `INSERT INTO sessions
           (id, title, cwd, project_id,
            forked_from_session_id, forked_from_turn_id,
            session_mode, narrative_policy, permission_mode, tts_enabled,
            provider_id, model_id, reasoning_effort,
            created_at, updated_at, last_activity_at, sidebar_order)
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(sidebar_order), 0) + 1
              FROM sessions
             WHERE archived_at IS NULL
               AND pinned = 0
               AND project_id IS ?)
         )`,
      ).run(newId, title, src.cwd,
        src.project_id,
        srcId, untilTurnId ?? null,
        src.session_mode, src.narrative_policy, src.permission_mode, src.tts_enabled,
        src.provider_id, src.model_id, src.reasoning_effort,
        createdAt, createdAt, createdAt, src.project_id);

      // 2. 构建 old->new turn id 映射。Turn 被复制以使 fork 出的 Session
      //    保留触发来源、模式、模型冻结与时序。
      this.db.prepare('CREATE TEMP TABLE _turn_id_map (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL)').run();

      const cutoffTurn = untilTurnId
        ? this.db.prepare(
          'SELECT id, created_at FROM turns WHERE id = ? AND session_id = ?',
        ).get(untilTurnId, srcId) as {
          id: string;
          created_at: number;
        } | undefined
        : undefined;

      if (untilTurnId && !cutoffTurn) {
        throw new Error(`Fork cutoff turn does not belong to source session: ${untilTurnId}`);
      }

      this.db.prepare(
        cutoffTurn
          ? `INSERT INTO _turn_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM turns
             WHERE session_id = ?
               AND (
                 created_at < ?
                 OR (created_at = ? AND id <= ?)
               )`
          : `INSERT INTO _turn_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM turns WHERE session_id = ?`,
      ).run(srcId, ...(cutoffTurn
        ? [cutoffTurn.created_at, cutoffTurn.created_at, cutoffTurn.id]
        : []));

      // 3. 复制 Turn，并重新生成 ID。
      this.db.prepare(
        `INSERT INTO turns
           (id, session_id, status, trigger_type,
            session_mode, narrative_policy, provider_id, model_id, protocol,
            iterations,
            created_at, completed_at, error_code, error_message)
         SELECT m.new_id, ?, t.status, t.trigger_type,
                 t.session_mode, t.narrative_policy, t.provider_id, t.model_id, t.protocol,
                 t.iterations,
                 t.created_at, t.completed_at, t.error_code, t.error_message
         FROM turns t JOIN _turn_id_map m ON m.old_id = t.id
         ORDER BY t.created_at ASC`,
      ).run(newId);

      // 历史 Turn 的用量明细随 Turn 身份一起复制，Session 级手动 Compact 不属于
      // 任何 Turn，不进入 fork 后 Session 的历史消费。
      this.db.prepare(`
        INSERT INTO usage_records (
          id, session_id, turn_id, provider_id, model_id, capability, status,
          input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
          quantity, unit, duration_ms, error_code, created_at
        )
        SELECT lower(hex(randomblob(16))), ?, turn_map.new_id,
               usage.provider_id, usage.model_id, usage.capability, usage.status,
               usage.input_tokens, usage.output_tokens,
               usage.cache_read_input_tokens, usage.cache_write_input_tokens,
               usage.quantity, usage.unit, usage.duration_ms, usage.error_code, usage.created_at
        FROM usage_records usage
        JOIN _turn_id_map turn_map ON turn_map.old_id = usage.turn_id
        ORDER BY usage.created_at ASC, usage.id ASC
      `).run(newId);

      // 4. 复制 message。带 turn_id 的消息严格跟随已选 Turn 集合，不能只按
      //    created_at 截断，否则相同时间戳的后续 Turn 会混入 fork。
      //    无 turn_id 的 session 级消息优先按目标 Turn 最后一条消息的稳定复合边界复制。
      //    目标 Turn 没有消息时，已完成 Turn 回退到 completed_at，否则回退到
      //    created_at，避免合法的 session 级系统上下文被整批丢弃。
      const messageCutoff = untilTurnId
        ? this.db.prepare(`
            SELECT created_at, id
            FROM messages
            WHERE session_id = ? AND turn_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `).get(srcId, untilTurnId) as { created_at: number; id: string } | undefined
        : undefined;
      const cutoffCompletedAt = untilTurnId
        ? (this.db.prepare('SELECT completed_at FROM turns WHERE id = ?')
            .get(untilTurnId) as { completed_at: number | null }).completed_at
        : undefined;
      const messageCutoffAt = messageCutoff?.created_at
        ?? cutoffCompletedAt
        ?? cutoffTurn?.created_at;
      const messageCutoffId = messageCutoff?.id;

      // 4. 复制 message。先为将被复制的消息生成新 ID 写入 _message_id_map，再执行
      //    复制：turn_id 经 _turn_id_map、summarized_through_message_id 经
      //    _message_id_map 转换。不能在 INSERT SELECT 中临时 randomblob()，否则
      //    Summary 无法知道游标目标的新 ID。
      this.db.prepare('CREATE TEMP TABLE _message_id_map (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL)').run();
      this.db.prepare(
        untilTurnId
          ? `INSERT INTO _message_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM messages
             WHERE session_id = ?
               AND (
                 turn_id IN (SELECT old_id FROM _turn_id_map)
                 OR (
                   turn_id IS NULL
                   AND ? IS NOT NULL
                   AND (
                      created_at < ?
                      OR (
                        created_at = ?
                        AND (? IS NULL OR id <= ?)
                      )
                    )
                  )
               )`
          : `INSERT INTO _message_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM messages
             WHERE session_id = ?`,
      ).run(srcId, ...(untilTurnId
        ? [
          messageCutoffAt ?? null,
          messageCutoffAt ?? 0,
          messageCutoffAt ?? 0,
          messageCutoffId ?? null,
          messageCutoffId ?? '',
        ]
        : []));

      this.db.prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at,
            summarized_through_message_id)
         SELECT message_map.new_id, ?,
                turn_map.new_id,
                source.role, source.kind, source.blocks_json, source.interrupted, source.created_at,
                cursor_map.new_id
         FROM messages source
         JOIN _message_id_map message_map ON message_map.old_id = source.id
         LEFT JOIN _turn_id_map turn_map ON turn_map.old_id = source.turn_id
         LEFT JOIN _message_id_map cursor_map ON cursor_map.old_id = source.summarized_through_message_id
         ORDER BY source.created_at ASC, source.id ASC`,
      ).run(newId);

      // 附件账本不复制:消息块里的 path 是全局主键,fork 的消息引用源 Session
      // 的同一批受管文件;源 Session 删除后这些 path 失效,投影自会降级。
      this.db.prepare('DROP TABLE _message_id_map').run();
      this.db.prepare('DROP TABLE _turn_id_map').run();
    })();

    const count = this.db
      .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
      .get(newId) as { cnt: number };
    return count.cnt;
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────────

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ── Patch(事务性部分更新)──────────────────────────────────────────────────────

  /**
   * 原子地应用部分更新。所有子更新在单个 SQLite 事务内执行;
   * 任何失败回滚整个 patch,行不会处于半改状态。
   */
  patch(
    id: string,
    patch: {
      title?:          string;
      pinned?:         boolean;
      cwd?:  string;
      sessionMode?: SessionModeRow;
      narrativePolicy?: NarrativePolicyRow;
      permissionMode?: PermissionModeRow;
      ttsEnabled?: boolean;
      providerId?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffortRow;
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
      setClauses.push('pinned = 1');
    } else if (patch.pinned === false) {
      setClauses.push('pinned = 0');
    }
    if (patch.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(patch.cwd);
    }
    if (patch.sessionMode !== undefined) {
      setClauses.push('session_mode = ?');
      values.push(patch.sessionMode);
    }
    if (patch.narrativePolicy !== undefined) {
      setClauses.push('narrative_policy = ?');
      values.push(patch.narrativePolicy);
    }
    if (patch.permissionMode !== undefined) {
      setClauses.push('permission_mode = ?');
      values.push(patch.permissionMode);
    }
    if (patch.ttsEnabled !== undefined) {
      setClauses.push('tts_enabled = ?');
      values.push(patch.ttsEnabled ? 1 : 0);
    }
    if (patch.providerId !== undefined && patch.modelId !== undefined) {
      setClauses.push('provider_id = ?', 'model_id = ?');
      values.push(patch.providerId, patch.modelId);
    }
    if (patch.reasoningEffort !== undefined) {
      setClauses.push('reasoning_effort = ?');
      values.push(patch.reasoningEffort);
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(now);
    values.push(id);

    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`)
        .run(...values);
      if (patch.pinned !== undefined) this.moveToTop(id);
    })();
  }

  private moveToTop(id: string): void {
    const row = this.findById(id);
    if (!row) throw new Error(`session_not_found: ${id}`);
    const { sql, params } = bucketWhere(row);
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(sidebar_order), 0) + 1 FROM sessions WHERE ${sql} AND id <> ?`)
      .pluck()
      .get(...params, id) as number;
    this.db.prepare('UPDATE sessions SET sidebar_order = ? WHERE id = ?').run(next, id);
  }

  private writeOrder(ids: string[]): void {
    const update = this.db.prepare('UPDATE sessions SET sidebar_order = ? WHERE id = ?');
    for (let index = 0; index < ids.length; index += 1) {
      update.run(ids.length - index, ids[index]!);
    }
  }
}

function activeBucketWhere(pinned: boolean, projectId: string | null): {
  sql: string;
  params: unknown[];
} {
  if (pinned) return { sql: 'archived_at IS NULL AND pinned = 1', params: [] };
  return projectId === null
    ? { sql: 'archived_at IS NULL AND pinned = 0 AND project_id IS NULL', params: [] }
    : { sql: 'archived_at IS NULL AND pinned = 0 AND project_id = ?', params: [projectId] };
}

function bucketWhere(row: SessionRow): { sql: string; params: unknown[] } {
  if (row.archived_at !== null) return { sql: 'archived_at IS NOT NULL', params: [] };
  return activeBucketWhere(row.pinned === 1, row.project_id);
}

function insertSessionBefore(
  ids: string[],
  movedId: string,
  beforeId: string | null,
): void {
  if (beforeId === null) {
    ids.push(movedId);
    return;
  }
  const index = ids.indexOf(beforeId);
  if (index < 0) throw new Error(`session_drop_target_not_found: ${beforeId}`);
  ids.splice(index, 0, movedId);
}
