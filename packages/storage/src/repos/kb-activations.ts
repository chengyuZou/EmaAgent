import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '../database.js';

export interface KbActivationRow {
  id:         string;
  call_id:    string;
  kb_id:      string;
  asset_id:   string;
  session_id: string;
  turn_id:    string | null;
  created_at: number;
}

export class KbActivationsRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * 记录一次 kb_search 调用：每个选中的 asset 插一行，共享同一个 call_id，
   * 使调用次数和 per-asset 使用量都可推导。
   * assetIds 为空时为 no-op（如无 scope 的"所有 KB"搜索）。
   */
  recordCall(args: {
    kbId:      string;
    assetIds:  string[];
    sessionId: string;
    turnId?:   string;
    ts?:       number;
  }): void {
    if (args.assetIds.length === 0) return;
    const callId = randomUUID();
    const ts     = args.ts ?? Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO kb_activations (id, call_id, kb_id, asset_id, session_id, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const assetId of args.assetIds) {
        stmt.run(randomUUID(), callId, args.kbId, assetId, args.sessionId, args.turnId ?? null, ts);
      }
    })();
  }

  /** 该 session 中发生了多少次 kb_search 调用（按 call_id 去重）。 */
  countCallsForSession(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT call_id) AS n FROM kb_activations WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** 使用过该 KB 文档的去重 session 列表。 */
  sessionsForAsset(assetId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT session_id FROM kb_activations WHERE asset_id = ?')
      .all(assetId) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  /** 该 session 中使用过的去重 KB 文档列表。 */
  assetsForSession(sessionId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT asset_id FROM kb_activations WHERE session_id = ?')
      .all(sessionId) as Array<{ asset_id: string }>;
    return rows.map(r => r.asset_id);
  }

  /** 单个 KB 文档的 per-session 使用明细（含 session 标题）。 */
  usageForAsset(assetId: string): AssetUsage {
    const sessions = this.db.prepare(`
      SELECT a.session_id            AS sessionId,
             COALESCE(s.title, '')   AS title,
             COUNT(DISTINCT a.call_id) AS calls
      FROM   kb_activations a
      LEFT JOIN sessions s ON s.id = a.session_id
      WHERE  a.asset_id = ?
      GROUP  BY a.session_id
      ORDER  BY calls DESC
    `).all(assetId) as Array<{ sessionId: string; title: string; calls: number }>;
    const totalCalls = sessions.reduce((n, r) => n + r.calls, 0);
    return { totalCalls, sessions };
  }
}

export interface AssetUsage {
  totalCalls: number;
  sessions:   Array<{ sessionId: string; title: string; calls: number }>;
}
