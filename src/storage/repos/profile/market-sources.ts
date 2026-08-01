import type { SqliteDb } from '../../database/database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────

import type { ProtectedDeleteResult } from './mutation-results.js';

export interface MarketSourceRow {
  id:         string;
  kind:       string;        // 'mcp' | 'skill' | 未来 'integration' —— 业务包填,底层不约束
  type:       string;        // 'github' | 'mcp-registry' | 'json-index' —— 业务包定义
  label:      string;
  config:     string;        // JSON,结构由业务包 adapter 定义
  enabled:    number;        // 0 | 1
  builtin:    number;        // 0 | 1 —— builtin 不可删,只能启停
  sort_order: number;
  created_at: number;
}

// ── MarketSourcesRepo ─────────────────────────────────────────────────────────
//
// Pure SQL —— 不 import 任何业务包(mcp/skill),避免循环依赖。
// config 字段以 raw string 存取,结构校验在各业务包的 adapter 里。
// 这张表是底层底座:任何 kind 的市场源都存这里,按 kind 过滤。

export class MarketSourcesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: MarketSourceRow): void {
    this.db.prepare(`
      INSERT INTO market_sources (id, kind, type, label, config, enabled, builtin, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.kind, row.type, row.label, row.config,
      row.enabled, row.builtin, row.sort_order, row.created_at,
    );
  }

  update(id: string, patch: {
    label?:     string;
    config?:    string;
    enabled?:   number;
    sort_order?: number;
  }): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    if (patch.label     !== undefined) { cols.push('label = ?');       values.push(patch.label); }
    if (patch.config    !== undefined) { cols.push('config = ?');      values.push(patch.config); }
    if (patch.enabled   !== undefined) { cols.push('enabled = ?');     values.push(patch.enabled); }
    if (patch.sort_order !== undefined) { cols.push('sort_order = ?'); values.push(patch.sort_order); }

    if (cols.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE market_sources SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }

  findById(id: string): MarketSourceRow | null {
    return (this.db.prepare('SELECT * FROM market_sources WHERE id = ?').get(id) as MarketSourceRow | undefined) ?? null;
  }

  listByKind(kind: string): MarketSourceRow[] {
    return this.db.prepare(
      'SELECT * FROM market_sources WHERE kind = ? ORDER BY sort_order ASC, created_at ASC',
    ).all(kind) as MarketSourceRow[];
  }

  listAll(): MarketSourceRow[] {
    return this.db.prepare(
      'SELECT * FROM market_sources ORDER BY kind ASC, sort_order ASC, created_at ASC',
    ).all() as MarketSourceRow[];
  }

  listEnabledByKind(kind: string): MarketSourceRow[] {
    return this.db.prepare(
      'SELECT * FROM market_sources WHERE kind = ? AND enabled = 1 ORDER BY sort_order ASC, created_at ASC',
    ).all(kind) as MarketSourceRow[];
  }

  deleteById(id: string): ProtectedDeleteResult {
    return this.db.transaction(() => {
      const deleted = this.db
        .prepare('DELETE FROM market_sources WHERE id = ? AND builtin = 0')
        .run(id);
      if (deleted.changes === 1) return 'deleted';

      const existing = this.db
        .prepare('SELECT 1 FROM market_sources WHERE id = ?')
        .get(id);
      return existing ? 'builtin_protected' : 'not_found';
    })();
  }
}
