// profile.db.permission_rules 的纯 SQL 仓储;不 import permission 业务包,避免循环依赖。
import type { SqliteDb } from '../../database/database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────

export interface PermissionRuleRow {
  id:            string;
  action:        string;        // 'allow' | 'deny' | 'ask' —— 由业务包约束
  tool_id:       string;
  path_glob:     string | null;
  scope:         string;        // 'global' | 'workspace'
  workspace_root: string | null; // scope=workspace 时必填,scope=global 时 NULL
  enabled:       number;        // 0 | 1
  created_at:    number;
  updated_at:    number;
}

// ── PermissionRulesRepo ───────────────────────────────────────────────────────
//
// 纯 SQL 实现:action/scope 的合法值由表 CHECK 约束保证,这里只做存取。
// 业务语义(规则匹配、内置规则、Session 临时授权)由 permission 包负责,
// Core 装配层负责 PermissionRuleRow ↔ PersistedPermissionRule 转换。

export class PermissionRulesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: PermissionRuleRow): void {
    this.db.prepare(`
      INSERT INTO permission_rules
        (id, action, tool_id, path_glob, scope, workspace_root, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.action, row.tool_id, row.path_glob,
      row.scope, row.workspace_root, row.enabled,
      row.created_at, row.updated_at,
    );
  }

  update(id: string, patch: {
    action?:     string;
    path_glob?:  string | null;
    enabled?:    number;
  }): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    if (patch.action    !== undefined) { cols.push('action = ?');    values.push(patch.action); }
    if (patch.path_glob !== undefined) { cols.push('path_glob = ?'); values.push(patch.path_glob); }
    if (patch.enabled   !== undefined) { cols.push('enabled = ?');   values.push(patch.enabled); }

    if (cols.length === 0) return;
    cols.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE permission_rules SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }

  findById(id: string): PermissionRuleRow | null {
    return (this.db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(id) as PermissionRuleRow | undefined) ?? null;
  }

  list(): PermissionRuleRow[] {
    return this.db.prepare(
      'SELECT * FROM permission_rules ORDER BY scope ASC, tool_id ASC, created_at ASC',
    ).all() as PermissionRuleRow[];
  }

  listEnabled(): PermissionRuleRow[] {
    return this.db.prepare(
      'SELECT * FROM permission_rules WHERE enabled = 1 ORDER BY scope ASC, tool_id ASC, created_at ASC',
    ).all() as PermissionRuleRow[];
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id);
    return result.changes === 1;
  }
}
