// 读写 Session 行、稳定分页、搜索投影、项目分组投影、Fork 和事务性偏好更新。
// Row 枚举由 storage 自持（SQL CHECK 的映射）；领域词汇归 @ema-agent/turn-terms 叶子，业务包在边界显式映射。
import type { SqliteDb } from '../../database/database.js';
import type { TurnStatusRow } from './turns.js';
import { buildFtsQuery } from '../../search/zh-tokenizer.js';
import { escapeLikePattern } from '../../search/like-utils.js';

/** sessions/turns 行上的执行范围枚举（SQL CHECK 原样）。 */
export type ExecutionProfileRow = 'chat' | 'work';
/** sessions/turns 行上的剧情策略枚举（SQL CHECK 原样）。 */
export type NarrativePolicyRow = 'auto' | 'always' | 'off';

export interface SessionRow {
  id: string;
  title: string;
  workspace_root:     string | null;
  /** 项目成员资格；在项目内 workspace_root 锁定为项目主文件夹。 */
  project_id:         string | null;
  created_at: number;
  /** 行元数据更新时间:title/pin/workspace/Profile 编辑。不用于 UI 中 Session 侧栏排序。 */
  updated_at: number;
  /** 对话活动时间:新 turn/message 开始时推进。用于UI中session侧栏排序。 */
  last_activity_at: number;
  archived_at: number | null;
  pinned:        number;        // 0 | 1
  /** fork 溯源：来源 Session 与截断点 Turn（完整复制时截断点为 null）。 */
  forked_from_session_id: string | null;
  forked_from_turn_id:    string | null;
  execution_profile: ExecutionProfileRow;
  narrative_policy: NarrativePolicyRow;
  /** 该 Session 当前使用的供应商配置；null 表示使用系统默认选择。 */
  provider_id: string | null;
  /** 该 Session 当前使用的模型；null 表示使用系统默认选择。 */
  model_id: string | null;
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
  snippet_json:       string | null;
  message_id:         string | null;
  message_created_at: number | null;
}

export interface SessionInsert {
  id: string;
  title: string;
  workspaceRoot?:  string | null;
  projectId?: string | null;
  forkedFromSessionId?: string;
  forkedFromTurnId?: string | null;
  executionProfile?: ExecutionProfileRow;
  narrativePolicy?: NarrativePolicyRow;
  model?: {
    providerId: string;
    modelId: string;
  } | null;
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
           (id, title, workspace_root, project_id,
            forked_from_session_id, forked_from_turn_id,
            execution_profile, narrative_policy,
            provider_id, model_id,
            created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title,
        s.workspaceRoot ?? null,
        s.projectId ?? null,
        s.forkedFromSessionId ?? null,
        s.forkedFromTurnId ?? null,
        s.executionProfile ?? 'chat',
        s.narrativePolicy ?? 'auto',
        s.model?.providerId ?? null,
        s.model?.modelId ?? null,
        s.createdAt, s.updatedAt,
        s.lastActivityAt ?? s.createdAt);
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
        ORDER BY s.pinned DESC, s.last_activity_at DESC, s.id DESC
      `)
      .all() as SessionRowEnriched[];
  }

  // ── 项目成员资格 ────────────────────────────────────────────────────────────

  /** 拖入项目：锁定成员资格并把 workspace_root 锁定为项目主文件夹。 */
  assignToProject(id: string, projectId: string, workspaceRoot: string, now: number): void {
    this.db
      .prepare('UPDATE sessions SET project_id = ?, workspace_root = ?, updated_at = ? WHERE id = ?')
      .run(projectId, workspaceRoot, now, id);
  }

  /** 拖出项目：只解除成员资格，workspace_root 保留原值恢复自由。 */
  removeFromProject(id: string, now: number): void {
    this.db
      .prepare('UPDATE sessions SET project_id = NULL, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  /** 项目换主/继位时级联改写全部成员的 workspace_root。 */
  cascadeWorkspaceForProject(projectId: string, workspaceRoot: string, now: number): void {
    this.db
      .prepare('UPDATE sessions SET workspace_root = ?, updated_at = ? WHERE project_id = ?')
      .run(workspaceRoot, now, projectId);
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
            m.blocks_json,
            d.created_at,
            ROW_NUMBER() OVER (
              PARTITION BY d.session_id
              ORDER BY d.created_at DESC, d.message_id DESC
            ) AS row_number
          FROM message_search_fts fts
          JOIN message_search_documents d ON d.message_id = fts.message_id
          JOIN messages m ON m.id = d.message_id
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
            ELSE mm.blocks_json
          END AS snippet_json,
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

  touchActivity(id: string, at: number): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?')
      .run(at, at, id);
  }

  // ── 置顶 / 取消置顶 ────────────────────────────────────────────────────────

  pin(id: string, now: number): void {
    this.db
      .prepare('UPDATE sessions SET pinned = 1, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  unpin(id: string): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE sessions SET pinned = 0, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  // ── 归档 / 取消归档 ────────────────────────────────────────────────────────────

  archive(id: string, archivedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archivedAt, archivedAt, id);
  }

  unarchive(id: string): void {
    this.db
      .prepare('UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
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
           (id, title, workspace_root, project_id,
            forked_from_session_id, forked_from_turn_id,
            execution_profile, narrative_policy,
            provider_id, model_id,
            created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, title, src.workspace_root,
        src.project_id,
        srcId, untilTurnId ?? null,
        src.execution_profile, src.narrative_policy,
        src.provider_id, src.model_id,
        createdAt, createdAt, createdAt);

      // 2. 构建 old->new turn id 映射。Turn 被复制以使 fork 出的 session
      //    保留触发来源、Profile、模型冻结、usage 与时序。
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
            execution_profile, narrative_policy, provider_id, model_id,
            iterations, usage_input_tokens, usage_output_tokens,
            created_at, completed_at, error_code, error_message)
         SELECT m.new_id, ?, t.status, t.trigger_type,
                t.execution_profile, t.narrative_policy, t.provider_id, t.model_id,
                t.iterations, t.usage_input_tokens, t.usage_output_tokens,
                t.created_at, t.completed_at, t.error_code, t.error_message
         FROM turns t JOIN _turn_id_map m ON m.old_id = t.id
         ORDER BY t.created_at ASC`,
      ).run(newId);

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

      this.db.prepare(
        untilTurnId
          ? `INSERT INTO messages
               (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
             SELECT lower(hex(randomblob(16))), ?,
                    (SELECT m.new_id FROM _turn_id_map m WHERE m.old_id = messages.turn_id),
                    role, kind, blocks_json, interrupted, created_at
             FROM messages
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
               )
             ORDER BY created_at ASC, id ASC`
          : `INSERT INTO messages
               (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
             SELECT lower(hex(randomblob(16))), ?,
                    (SELECT m.new_id FROM _turn_id_map m WHERE m.old_id = messages.turn_id),
                    role, kind, blocks_json, interrupted, created_at
             FROM messages
             WHERE session_id = ?
             ORDER BY created_at ASC, id ASC`,
      ).run(newId, srcId, ...(untilTurnId
         ? [
          messageCutoffAt ?? null,
          messageCutoffAt ?? 0,
          messageCutoffAt ?? 0,
          messageCutoffId ?? null,
          messageCutoffId ?? '',
        ]
        : []));

      // 5. 复制 attachments--新 id,turn_id 重映射,session_id = 新。
      //    不复制的话,fork 中用户消息的 attachment 角标会消失
      //    (attachmentStore.listByTurn(newTurnId) 会是空的)。
      this.db.prepare(
        `INSERT INTO attachments
           (id, turn_id, session_id, kind, name, mime, source_path, byte_size, source_modified_at,
            image_path, image_byte_size, created_at)
         SELECT lower(hex(randomblob(16))), m.new_id, ?, ta.kind, ta.name, ta.mime,
                ta.source_path, ta.byte_size, ta.source_modified_at,
                ta.image_path, ta.image_byte_size, ta.created_at
         FROM attachments ta
         JOIN _turn_id_map m ON m.old_id = ta.turn_id`,
      ).run(newId);

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
      workspaceRoot?:  string | null;
      executionProfile?: ExecutionProfileRow;
      narrativePolicy?: NarrativePolicyRow;
      model?: {
        providerId: string;
        modelId: string;
      } | null;
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
    if (patch.workspaceRoot !== undefined) {
      setClauses.push('workspace_root = ?');
      values.push(patch.workspaceRoot);
    }
    if (patch.executionProfile !== undefined) {
      setClauses.push('execution_profile = ?');
      values.push(patch.executionProfile);
    }
    if (patch.narrativePolicy !== undefined) {
      setClauses.push('narrative_policy = ?');
      values.push(patch.narrativePolicy);
    }
    if (patch.model !== undefined) {
      setClauses.push('provider_id = ?', 'model_id = ?');
      values.push(
        patch.model?.providerId ?? null,
        patch.model?.modelId ?? null,
      );
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
