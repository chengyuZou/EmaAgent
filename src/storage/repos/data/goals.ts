import type { SqliteDb } from '../../database/database.js';

export type GoalStatusRow = 'active' | 'paused' | 'completed';
export type GoalReasonRow = 'succeeded' | 'failed' | 'cancelled';

export interface GoalRow {
  id: string;
  session_id: string;
  objective: string;
  feedback: string | null;
  status: GoalStatusRow;
  version: number;
  reason: GoalReasonRow | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export type GoalSummaryRow = Pick<GoalRow,
  'id' | 'session_id' | 'objective' | 'status' | 'reason' | 'created_at' | 'updated_at' | 'completed_at'
>;

export class GoalsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: GoalRow): void {
    this.db.prepare(`
      INSERT INTO goals (
        id, session_id, objective, feedback, status, version, reason, error,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.session_id, row.objective, row.feedback, row.status, row.version,
      row.reason, row.error, row.created_at, row.updated_at, row.completed_at,
    );
  }

  findById(sessionId: string, goalId: string): GoalRow | undefined {
    return this.db.prepare('SELECT * FROM goals WHERE session_id = ? AND id = ?')
      .get(sessionId, goalId) as GoalRow | undefined;
  }

  findCurrent(sessionId: string): GoalRow | undefined {
    return this.db.prepare(`
      SELECT * FROM goals WHERE session_id = ? AND status IN ('active', 'paused')
    `).get(sessionId) as GoalRow | undefined;
  }

  listSummariesForSession(sessionId: string): GoalSummaryRow[] {
    return this.db.prepare(`
      SELECT id, session_id, objective, status, reason, created_at, updated_at, completed_at
      FROM goals WHERE session_id = ? ORDER BY created_at DESC, id DESC
    `).all(sessionId) as GoalSummaryRow[];
  }

  listActive(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'active'")
      .all() as GoalRow[];
  }

  update(row: GoalRow): void {
    this.db.prepare(`
      UPDATE goals SET objective = ?, feedback = ?, status = ?, version = ?, reason = ?, error = ?,
        updated_at = ?, completed_at = ?
      WHERE session_id = ? AND id = ?
    `).run(
      row.objective, row.feedback, row.status, row.version, row.reason, row.error,
      row.updated_at, row.completed_at, row.session_id, row.id,
    );
  }

  delete(sessionId: string, goalId: string): void {
    this.db.prepare('DELETE FROM goals WHERE session_id = ? AND id = ?')
      .run(sessionId, goalId);
  }
}
