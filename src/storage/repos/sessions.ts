import type { TurnStatus } from '@ema-agent/turn';
// 读写 Session 行、稳定分页、搜索投影、Fork 和事务性偏好更新。
import type { SqliteDb } from '../database.js';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';
import { buildFtsQuery } from '../zh-tokenizer.js';

export interface SessionRow {
  id: string;
  title: string;
  workspace_root:     string | null;
  created_at: number;
  /** 行元数据更新时间:title/group/pin/workspace/Profile 编辑。不用于 UI 中 Session 侧栏排序。 */
  updated_at: number;
  /** 对话活动时间:新 turn/message 开始时推进。用于UI中session侧栏排序。 */
  last_activity_at: number;
  archived_at: number | null;
  pinned:        number;        // 0 | 1
  pinned_at:     number | null;
  group_label:   string | null;
  /** 整个session fork 使用 表示 fork 溯源 */
  parent_session_id: string | null;
  execution_profile: ExecutionProfile;
  narrative_policy: NarrativePolicy;
  /** 用户希望该 Session 下一轮默认使用的供应商配置；null 表示使用系统默认选择。 */
  preferred_provider_config_id: string | null;
  /** 用户希望该 Session 下一轮默认使用的模型；null 表示使用系统默认选择。 */
  preferred_model_id: string | null;
  last_viewed_at:   number | null;
}

/** SessionRow 带 JOIN 查询派生的 turn 字段。 */
export interface SessionRowEnriched extends SessionRow {
  last_turn_status:       TurnStatus | null;
  last_turn_completed_at: number | null;
  running_turn_count:     number;
}

/** SessionRow 带 JOIN 查询派生的 turn 字段 + 搜索匹配字段 用于查找 session标题/session内Message */
export interface SessionSearchRow extends SessionRowEnriched {
  match_kind:         'title' | 'message';
  snippet_json:       string | null;
  message_id:         string | null;
  message_created_at: number | null;
}

export interface SessionInsert {
  id: SessionId;
  title: string;
  workspaceRoot?:  string | null;
  parentSessionId?: string;
  executionProfile?: ExecutionProfile;
  narrativePolicy?: NarrativePolicy;
  preferredModel?: {
    providerConfigId: string;
    modelId: string;
  } | null;
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
           (id, title, workspace_root,
            parent_session_id, execution_profile, narrative_policy,
            preferred_provider_config_id, preferred_model_id,
            created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title,
        s.workspaceRoot ?? null,
        s.parentSessionId ?? null,
        s.executionProfile ?? 'chat',
        s.narrativePolicy ?? 'auto',
        s.preferredModel?.providerConfigId ?? null,
        s.preferredModel?.modelId ?? null,
        s.createdAt, s.updatedAt,
        s.lastActivityAt ?? s.createdAt);
  }

  findById(id: SessionId): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  /**
   * 基于 V1 不透明 cursor 的稳定 keyset 分页。
   *
   * 排序键为 `(pinned DESC, last_activity_at DESC, id DESC)`。随机文本 ID
   * 不需要具备时间含义，只负责在前两个字段相同时提供稳定且唯一的
   * 最终顺序，避免翻页边界丢失或重复 session。
   */
  listActive(limit: number, cursor?: string): SessionRowEnriched[] {
    const parsed = parseCursor(cursor);
    if (parsed) {
      return this.db
        .prepare(
          `WITH latest_turn AS (
             SELECT
               t.session_id,
               t.status,
               t.completed_at,
               ROW_NUMBER() OVER (
                 PARTITION BY t.session_id
                 ORDER BY t.started_at DESC, t.id DESC
               ) AS row_number
             FROM turns t
           ),
           running_turns AS (
             SELECT session_id, COUNT(*) AS running_turn_count
             FROM turns
             WHERE status = 'running'
             GROUP BY session_id
           )
           SELECT
             s.*,
             lt.status AS last_turn_status,
             lt.completed_at AS last_turn_completed_at,
             COALESCE(rt.running_turn_count, 0) AS running_turn_count
           FROM sessions s
           LEFT JOIN latest_turn lt
             ON lt.session_id = s.id
            AND lt.row_number = 1
           LEFT JOIN running_turns rt ON rt.session_id = s.id
           WHERE s.archived_at IS NULL
             AND (
               s.pinned < ?
               OR (s.pinned = ? AND s.last_activity_at < ?)
               OR (s.pinned = ? AND s.last_activity_at = ? AND s.id < ?)
             )
           ORDER BY s.pinned DESC, s.last_activity_at DESC, s.id DESC
           LIMIT ?`,
        )
        .all(
          parsed.pinned,
          parsed.pinned,
          parsed.lastActivityAt,
          parsed.pinned,
          parsed.lastActivityAt,
          parsed.id,
          limit,
        ) as SessionRowEnriched[];
    }
    return this.db
      .prepare(
        `WITH latest_turn AS (
           SELECT
             t.session_id,
             t.status,
             t.completed_at,
             ROW_NUMBER() OVER (
               PARTITION BY t.session_id
               ORDER BY t.started_at DESC, t.id DESC
             ) AS row_number
           FROM turns t
         ),
         running_turns AS (
           SELECT session_id, COUNT(*) AS running_turn_count
           FROM turns
           WHERE status = 'running'
           GROUP BY session_id
         )
         SELECT
           s.*,
           lt.status AS last_turn_status,
           lt.completed_at AS last_turn_completed_at,
           COALESCE(rt.running_turn_count, 0) AS running_turn_count
         FROM sessions s
         LEFT JOIN latest_turn lt
           ON lt.session_id = s.id
          AND lt.row_number = 1
         LEFT JOIN running_turns rt ON rt.session_id = s.id
         WHERE s.archived_at IS NULL
         ORDER BY s.pinned DESC, s.last_activity_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(limit) as SessionRowEnriched[];
  }

  /**
   * 侧边栏 UI 的分组列表:
   *   pinned   - 置顶 session(最近更新优先)
   *   byGroup  - 带 group_label 的 session,按 label 分组
   *   recent   - 未置顶、未分组、活跃 session
   *   archived - 软删除 session
   */
  /**
   * 侧边栏布局:
   *   byGroup  - 带 group_label 的 session,每组内置顶优先
   *   pinned   - 置顶但无 group_label 的 session
   *   recent   - 其余(未归档、未置顶、无分组)
   *   archived - 软删除
   *
   * 折叠/展开纯前端逻辑--后端返回扁平 bucket。
   */
  listGrouped(): { pinned: SessionRowEnriched[]; byGroup: Array<{ label: string; sessions: SessionRowEnriched[] }>; recent: SessionRowEnriched[]; archived: SessionRowEnriched[] } {
    const all = this.db
      .prepare(`
        WITH latest_turn AS (
          SELECT
            t.session_id,
            t.status,
            t.completed_at,
            ROW_NUMBER() OVER (
              PARTITION BY t.session_id
              ORDER BY t.started_at DESC, t.id DESC
            ) AS row_number
          FROM turns t
        ),
        running_turns AS (
          SELECT session_id, COUNT(*) AS running_turn_count
          FROM turns
          WHERE status = 'running'
          GROUP BY session_id
        )
        SELECT
          s.*,
          lt.status AS last_turn_status,
          lt.completed_at AS last_turn_completed_at,
          COALESCE(rt.running_turn_count, 0) AS running_turn_count
        FROM sessions s
        LEFT JOIN latest_turn lt
          ON lt.session_id = s.id
         AND lt.row_number = 1
        LEFT JOIN running_turns rt ON rt.session_id = s.id
        ORDER BY s.pinned DESC, s.last_activity_at DESC, s.id DESC
      `)
      .all() as SessionRowEnriched[];

    const groupedMap = new Map<string, SessionRowEnriched[]>();
    const pinned:   SessionRowEnriched[] = [];
    const recent:   SessionRowEnriched[] = [];
    const archived: SessionRowEnriched[] = [];

    for (const s of all) {
      if (s.archived_at) { archived.push(s); continue; }

      // 分组 session 同时包含置顶和非置顶--前端在每个分组视觉区段内
      // 按置顶优先排序。
      if (s.group_label) {
        const list = groupedMap.get(s.group_label) ?? ([] as SessionRowEnriched[]);
        list.push(s);
        groupedMap.set(s.group_label, list);
        continue;
      }

      // 未分组
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
              ORDER BY t.started_at DESC, t.id DESC
            ) AS row_number
          FROM turns t
        ),
        running_turns AS (
          SELECT session_id, COUNT(*) AS running_turn_count
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
          COALESCE(rt.running_turn_count, 0) AS running_turn_count,
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

  // ── 置顶 / 取消置顶 ────────────────────────────────────────────────────────

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

  // ── 分组 ──────────────────────────────────────────────────────────────────────

  setGroup(id: SessionId, label: string | null): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE sessions SET group_label = ?, updated_at = ? WHERE id = ?')
      .run(label, now, id);
  }

  // ── 归档 / 取消归档 ────────────────────────────────────────────────────────────

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

  // ── Fork ──────────────────────────────────────────────────────────────────────

  /**
   * 把一个 Session 的 Turn、Message 和 Attachment 克隆为独立 Session。
   *
   * 所有实体重新生成 ID，Message 与 Attachment 通过临时映射表指向新 Turn。
   * `untilTurnId` 提供时只复制到该 Turn（含）为止，不能把同毫秒的后续
   * Turn 或无归属消息误带进新 Session。
   *
   * 返回复制的 message 数量。
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
      // 1. 新 Session 行复制 Workspace、执行偏好和下一轮模型偏好。
      //    parent_session_id 指回来源 session，用于 Fork 溯源。
      this.db.prepare(
        `INSERT INTO sessions
           (id, title, workspace_root,
            parent_session_id, execution_profile, narrative_policy,
            preferred_provider_config_id, preferred_model_id,
            created_at, updated_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId, title, src.workspace_root,
        srcId, src.execution_profile, src.narrative_policy,
        src.preferred_provider_config_id, src.preferred_model_id,
        createdAt, createdAt, createdAt);

      // 2. 构建 old->new turn id 映射。Turn 被复制以使 fork 出的 session
      //    保留触发来源、Profile、Narrative 策略、status、usage 与时序。
      //    没有它们，前端会丢失执行标签、Token 统计、TTS 重播和 Tool Result 分组。
      this.db.prepare('CREATE TEMP TABLE _turn_id_map (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL)').run();

      const cutoffTurn = untilTurnId
        ? this.db.prepare(
          'SELECT id, started_at, completed_at FROM turns WHERE id = ? AND session_id = ?',
        ).get(untilTurnId, srcId) as {
          id: string;
          started_at: number;
          completed_at: number | null;
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
                 started_at < ?
                 OR (started_at = ? AND id <= ?)
               )`
          : `INSERT INTO _turn_id_map (old_id, new_id)
             SELECT id, lower(hex(randomblob(16))) FROM turns WHERE session_id = ?`,
      ).run(srcId, ...(cutoffTurn
        ? [cutoffTurn.started_at, cutoffTurn.started_at, cutoffTurn.id]
        : []));

      // 3. 复制 Turn，并重新生成 ID。
      this.db.prepare(
        `INSERT INTO turns
           (id, session_id, trigger_type, execution_profile, narrative_policy,
            status, user_input, started_at, completed_at,
            error_code, error_message, iterations, usage_input_tokens, usage_output_tokens)
         SELECT m.new_id, ?, t.trigger_type, t.execution_profile, t.narrative_policy,
                t.status, t.user_input, t.started_at, t.completed_at,
                t.error_code, t.error_message, t.iterations,
                t.usage_input_tokens, t.usage_output_tokens
         FROM turns t JOIN _turn_id_map m ON m.old_id = t.id
         ORDER BY t.started_at ASC`,
      ).run(newId);

      // 4. 复制 message。带 turn_id 的消息严格跟随已选 Turn 集合，不能只按
      //    created_at 截断，否则相同时间戳的后续 Turn 会混入 fork。
      //    无 turn_id 的 session 级消息优先按目标 Turn 最后一条消息的稳定复合边界复制。
      //    目标 Turn 没有消息时，已完成 Turn 回退到 completed_at，未完成 Turn 回退到
      //    started_at，避免合法的 session 级系统上下文被整批丢弃。
      const messageCutoff = untilTurnId
        ? this.db.prepare(`
            SELECT created_at, id
            FROM messages
            WHERE session_id = ? AND turn_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `).get(srcId, untilTurnId) as { created_at: number; id: string } | undefined
        : undefined;
      const messageCutoffAt = messageCutoff?.created_at
        ?? cutoffTurn?.completed_at
        ?? cutoffTurn?.started_at;
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

      // 5. 复制 turn_attachments--新 id,turn_id 重映射,session_id = 新。
      //    不复制的话,fork 中用户消息的 attachment 角标会消失
      //    (attachmentStore.listByTurn(newTurnId) 会是空的)。
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

  // ── 运行中 turn 计数 ───────────────────────────────────────────────────────────

  /** 该 session 当前有多少 turn 正在运行。 */
  runningTurnCount(id: SessionId): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM turns WHERE session_id = ? AND status = 'running'")
      .get(id) as { cnt: number };
    return row.cnt;
  }

  // ── 删除 ──────────────────────────────────────────────────────────────────────

  delete(id: SessionId): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }


  // ── Patch(事务性部分更新)──────────────────────────────────────────────────────

  /**
   * 原子地应用部分更新。用于 `PUT /api/sessions/:id`,
   * 客户端可在一次请求中改 `title` + `pinned` + `groupLabel`。
   *
   * 所有子更新在单个 SQLite 事务内执行;任何失败回滚整个 patch,
   * 行不会处于半改状态。
   *
   * `groupLabel === null` 是显式的"移出分组"信号;
   * 调用方必须区分它与 `undefined`(不触碰)。
   */
  patch(
    id: SessionId,
    patch: {
      title?:          string;
      pinned?:         boolean;
      groupLabel?:     string | null;
      workspaceRoot?:  string | null;
      executionProfile?: ExecutionProfile;
      narrativePolicy?: NarrativePolicy;
      preferredModel?: {
        providerConfigId: string;
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
    if (patch.executionProfile !== undefined) {
      setClauses.push('execution_profile = ?');
      values.push(patch.executionProfile);
    }
    if (patch.narrativePolicy !== undefined) {
      setClauses.push('narrative_policy = ?');
      values.push(patch.narrativePolicy);
    }
    if (patch.preferredModel !== undefined) {
      setClauses.push('preferred_provider_config_id = ?', 'preferred_model_id = ?');
      values.push(
        patch.preferredModel?.providerConfigId ?? null,
        patch.preferredModel?.modelId ?? null,
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

// ── Cursor 辅助 ─────────────────────────────────────────────────────────────────

interface ParsedCursor {
  version: 1;
  pinned:    number;     // 0 | 1
  lastActivityAt: number;
  id: string;
}

/**
 * 解析 Base64URL 编码的 V1 cursor。畸形 cursor 会明确抛错，
 * 防止客户端静默回到第一页后产生重复分页循环。
 */
function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isCursorV1(decoded)) throw new Error('cursor payload schema mismatch');
    return {
      version: 1,
      pinned: decoded.p,
      lastActivityAt: decoded.a,
      id: decoded.i,
    };
  } catch (error) {
    throw new Error('Invalid sessions cursor', { cause: error });
  }
}

/**
 * 从 session 行构建 cursor。传入当前页最后一行;
 * 下一页查询将用它 keyset 跳到正确位置。
 */
export function nextCursorFor(row: SessionRow): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    p: row.pinned,
    a: row.last_activity_at,
    i: row.id,
  }), 'utf8').toString('base64url');
}

function isCursorV1(value: unknown): value is { v: 1; p: 0 | 1; a: number; i: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1
    && (candidate.p === 0 || candidate.p === 1)
    && typeof candidate.a === 'number'
    && Number.isSafeInteger(candidate.a)
    && typeof candidate.i === 'string'
    && candidate.i.length > 0;
}

/** 转义 SQLite LIKE 中具有通配语义的字符，使用户输入按字面匹配。
 * 用户搜 100% 会被解释成"100 后接任意串"(匹配所有 ≥100 的内容)。
 * 必须转义:%->\%、_->\_、\->\\,SQL 加 ESCAPE '\' 声明转义符。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
