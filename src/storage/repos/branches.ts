import type { SqliteDb } from '../database.js';
import type { BranchId, SessionId, TurnId } from '@ema-agent/ids';

export interface BranchRow {
  id:                string;
  session_id:        string;
  parent_branch_id:  string | null;
  fork_from_turn_id: string | null;
  created_at:        number;
}

export interface BranchInsert {
  id:              BranchId;
  sessionId:       SessionId;
  parentBranchId?: BranchId;
  forkFromTurnId?: TurnId;
  createdAt:       number;
}

export class BranchesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(b: BranchInsert): void {
    this.db
      .prepare(
        `INSERT INTO branches (id, session_id, parent_branch_id, fork_from_turn_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.sessionId, b.parentBranchId ?? null, b.forkFromTurnId ?? null, b.createdAt);
  }

  findById(id: BranchId): BranchRow | undefined {
    return this.db
      .prepare('SELECT * FROM branches WHERE id = ?')
      .get(id) as BranchRow | undefined;
  }

  /** Session 的根分支（parent_branch_id IS NULL）。 */
  findRoot(sessionId: SessionId): BranchRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM branches WHERE session_id = ? AND parent_branch_id IS NULL LIMIT 1',
      )
      .get(sessionId) as BranchRow | undefined;
  }

  listForSession(sessionId: SessionId): BranchRow[] {
    return this.db
      .prepare('SELECT * FROM branches WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as BranchRow[];
  }

  /**
   * 从同一 turn fork 出的所有分支—用于在 chat UI 渲染 < N/M > 兄弟导航。
   * 不包含父分支本身（调用方在构建兄弟列表时将其放在位置 0）。
   */
  listSiblingsAt(forkFromTurnId: TurnId): BranchRow[] {
    return this.db
      .prepare(
        'SELECT * FROM branches WHERE fork_from_turn_id = ? ORDER BY created_at ASC',
      )
      .all(forkFromTurnId) as BranchRow[];
  }

  /** 子分支数(parent_branch_id 指向 branchId)。>0 时不可删(FK 约束 + 孤儿子分支)。 */
  countChildren(branchId: BranchId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM branches WHERE parent_branch_id = ?')
      .get(branchId) as { n: number };
    return row.n;
  }

  /** 删除分支行。调用方负责确保无 turn / 无子分支引用(否则 FK 违反)。 */
  delete(branchId: BranchId): void {
    this.db.prepare('DELETE FROM branches WHERE id = ?').run(branchId);
  }
}
