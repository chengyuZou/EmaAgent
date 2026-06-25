import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '../database.js';

export interface KbActivationRow {
  id:         string;
  call_id:    string;
  asset_id:   string;
  session_id: string;
  turn_id:    string | null;
  created_at: number;
}

export class KbActivationsRepo {
  constructor(private readonly db: SqliteDb) {}

  /**
   * Record one kb_search call: inserts a row per selected asset, all sharing a
   * single call_id so call-count and per-asset-usage can both be derived.
   * No-op when assetIds is empty (e.g. an unscoped "all KBs" search).
   */
  recordCall(args: {
    assetIds:  string[];
    sessionId: string;
    turnId?:   string;
    ts?:       number;
  }): void {
    if (args.assetIds.length === 0) return;
    const callId = randomUUID();
    const ts     = args.ts ?? Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO kb_activations (id, call_id, asset_id, session_id, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const assetId of args.assetIds) {
        stmt.run(randomUUID(), callId, assetId, args.sessionId, args.turnId ?? null, ts);
      }
    })();
  }

  /** How many kb_search calls happened in this session (distinct call_id). */
  countCallsForSession(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(DISTINCT call_id) AS n FROM kb_activations WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** Distinct sessions in which this KB document was used. */
  sessionsForAsset(assetId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT session_id FROM kb_activations WHERE asset_id = ?')
      .all(assetId) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  /** Distinct KB documents used in this session. */
  assetsForSession(sessionId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT asset_id FROM kb_activations WHERE session_id = ?')
      .all(sessionId) as Array<{ asset_id: string }>;
    return rows.map(r => r.asset_id);
  }
}
