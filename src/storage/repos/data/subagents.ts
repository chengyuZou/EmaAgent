// 保存子代理身份和最近配置, 列表只读取身份行, 不加载 Run 的结果或统计.
import type { SqliteDb } from '../../database/database.js';
import type { PermissionModeRow, ReasoningEffortRow } from './sessions.js';

export type SubagentStatusRow = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentRow {
  id: string;
  session_id: string;
  title: string | null;
  description: string | null;
  /** 最近一次准备成功的 Run 实际权限, 不代表所有历史 Run 的权限. */
  permission_mode: PermissionModeRow | null;
  /** 最近一次准备成功的 Run 实际 Provider. */
  provider_id: string | null;
  /** 最近一次准备成功的 Run 实际模型. */
  model_id: string | null;
  /** 最近一次准备成功的 Run 实际调用协议. */
  protocol: string | null;
  /** 最近一次准备成功的 Run 实际思考强度. */
  reasoning_effort: ReasoningEffortRow | null;
  /** 最近一次 Run 的状态, 与 Run 的状态变化在同一事务内更新. */
  status: SubagentStatusRow;
  created_at: number;
  updated_at: number;
}

/** 新身份的 Title 和 description 必须由发起方提供, 旧行缺失的字段不补造. */
export interface SubagentInsert {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  createdAt: number;
}

export interface SubagentDetailsUpdate {
  title?: string;
  description?: string;
}

export interface SubagentPageCursor {
  updatedAt: number;
  id: string;
}

export interface SubagentPage {
  items: SubagentRow[];
  nextCursor: SubagentPageCursor | null;
}

export class SubagentsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 只创建身份, 首个 Run 由业务调用方在同一外层事务内插入. */
  insert(subagent: SubagentInsert): SubagentRow {
    return this.db.prepare(`
      INSERT INTO subagents (id, session_id, title, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      subagent.id, subagent.sessionId, subagent.title, subagent.description,
      subagent.createdAt, subagent.createdAt,
    ) as SubagentRow;
  }

  findById(subagentId: string): SubagentRow | undefined {
    return this.db.prepare('SELECT * FROM subagents WHERE id = ?')
      .get(subagentId) as SubagentRow | undefined;
  }

  listForSession(sessionId: string, cursor?: SubagentPageCursor, limit = 50): SubagentPage {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const rows = this.db.prepare(`
      SELECT * FROM subagents WHERE session_id = ? AND (
        ? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?)
      )
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(
      sessionId, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null, cursor?.id ?? null, pageSize + 1,
    ) as SubagentRow[];
    const items = rows.slice(0, pageSize);
    const last = items[items.length - 1];
    let nextCursor: SubagentPageCursor | null = null;
    if (rows.length > pageSize && last) {
      nextCursor = { updatedAt: last.updated_at, id: last.id };
    }
    return { items, nextCursor };
  }

  delete(subagentId: string): void {
    this.db.prepare('DELETE FROM subagents WHERE id = ?').run(subagentId);
  }

  deleteTerminalForSession(sessionId: string): number {
    return this.db.prepare("DELETE FROM subagents WHERE session_id = ? AND status <> 'running'")
      .run(sessionId).changes;
  }
}
