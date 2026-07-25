// profile.db 永久规则的 PermissionRuleStore 实现;负责 PermissionRuleRow ↔ PersistedPermissionRule 转换。
import { randomUUID } from 'node:crypto';
import { PermissionRulesRepo } from '@ema-agent/storage';
import type { PermissionRuleRow, SqliteDb } from '@ema-agent/storage';
import type { PermissionRule, PersistedPermissionRule } from '../types.js';
import type { PermissionRuleStore } from './permissionRuleStore.js';

// ── Row ↔ PersistedPermissionRule ─────────────────────────────────────────────

function rowToPersisted(row: PermissionRuleRow): PersistedPermissionRule {
  return {
    id:            row.id,
    action:        row.action as PermissionRule['action'],
    tool:          row.tool_id,
    pathGlob:      row.path_glob ?? undefined,
    scope:         row.scope as PermissionRule['scope'],
    workspaceRoot: row.workspace_root ?? undefined,
    enabled:       row.enabled === 1,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

// ── SqlPermissionRuleStore ────────────────────────────────────────────────────

/**
 * 用 PermissionRulesRepo 适配 PermissionRuleStore,持久化到 profile.db.permission_rules。
 *
 * Storage 包不依赖 permission 业务类型,因此 Row ↔ PersistedPermissionRule 转换在本层完成:
 *   tool_id ↔ tool / path_glob ↔ pathGlob / workspace_root ↔ workspaceRoot / enabled(0|1) ↔ boolean
 *
 * upsert 利用 SQL 唯一索引 (scope, workspace_root, tool_id, path_glob) 去重;
 * 命中既有行时只更新 action 与 enabled,不重置 id/createdAt。
 */
export class SqlPermissionRuleStore implements PermissionRuleStore {
  private readonly repo: PermissionRulesRepo;

  constructor(profileDb: SqliteDb) {
    this.repo = new PermissionRulesRepo(profileDb);
  }

  list(): PersistedPermissionRule[] {
    return this.repo.list().map(rowToPersisted);
  }

  listEnabled(): PersistedPermissionRule[] {
    return this.repo.listEnabled().map(rowToPersisted);
  }

  upsert(input: PermissionRule): PersistedPermissionRule {
    const existing = this.repo.list().find(row => sameSelector(row, input));
    const now = Date.now();
    if (existing) {
      this.repo.update(existing.id, {
        action:  input.action,
        enabled: 1,
      });
      return rowToPersisted(this.repo.findById(existing.id)!);
    }
    const id = randomUUID();
    const row: PermissionRuleRow = {
      id,
      action:         input.action,
      tool_id:        input.tool,
      path_glob:      input.pathGlob ?? null,
      scope:          input.scope,
      workspace_root: input.scope === 'workspace' ? input.workspaceRoot ?? null : null,
      enabled:        1,
      created_at:     now,
      updated_at:     now,
    };
    this.repo.insert(row);
    return rowToPersisted(row);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.repo.update(id, { enabled: enabled ? 1 : 0 });
  }

  delete(id: string): boolean {
    return this.repo.deleteById(id);
  }
}

/** 同 (tool, pathGlob, scope, workspaceRoot) 视为同一条规则(与 SQL 唯一索引一致)。 */
function sameSelector(row: PermissionRuleRow, input: PermissionRule): boolean {
  return row.tool_id === input.tool
    && (row.path_glob ?? undefined) === input.pathGlob
    && row.scope === input.scope
    && (row.workspace_root ?? undefined) === input.workspaceRoot;
}
