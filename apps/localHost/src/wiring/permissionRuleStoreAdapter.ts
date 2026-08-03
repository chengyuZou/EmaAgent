// 把 profile.db 的权限规则行映射为 Permission 业务包理解的持久规则。

import { randomUUID } from 'node:crypto';
import type {
  PermissionRule,
  PermissionRuleStore,
  PersistedPermissionRule,
} from '@ema-agent/permission';
import {
  PermissionRulesRepo,
  type PermissionRuleRow,
} from '@ema-agent/storage';

export class PermissionRuleStoreAdapter implements PermissionRuleStore {
  constructor(private readonly repo: PermissionRulesRepo) {}

  list(): PersistedPermissionRule[] {
    return this.repo.list().map(fromRow);
  }

  listEnabled(): PersistedPermissionRule[] {
    return this.repo.listEnabled().map(fromRow);
  }

  upsert(input: PermissionRule): PersistedPermissionRule {
    const existing = this.list().find(rule => sameSelector(rule, input));
    if (existing) {
      this.repo.update(existing.id, {
        action: input.action,
        path_glob: input.pathGlob ?? null,
      });
      return fromRow(requireRow(this.repo, existing.id));
    }

    const now = Date.now();
    const row: PermissionRuleRow = {
      id: randomUUID(),
      action: input.action,
      tool_id: input.tool,
      path_glob: input.pathGlob ?? null,
      scope: input.scope,
      workspace_root: input.workspaceRoot ?? null,
      enabled: 1,
      created_at: now,
      updated_at: now,
    };
    this.repo.insert(row);
    return fromRow(row);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    if (!this.repo.findById(id)) return false;
    this.repo.update(id, { enabled: enabled ? 1 : 0 });
    return true;
  }

  delete(id: string): boolean {
    return this.repo.deleteById(id);
  }
}

function fromRow(row: PermissionRuleRow): PersistedPermissionRule {
  if (!isAction(row.action) || !isScope(row.scope)) {
    throw new Error(`数据库中存在无效权限规则：${row.id}`);
  }
  return {
    id: row.id,
    action: row.action,
    tool: row.tool_id,
    pathGlob: row.path_glob ?? undefined,
    scope: row.scope,
    workspaceRoot: row.workspace_root ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireRow(repo: PermissionRulesRepo, id: string): PermissionRuleRow {
  const row = repo.findById(id);
  if (!row) throw new Error(`权限规则写入后无法读取：${id}`);
  return row;
}

function sameSelector(left: PermissionRule, right: PermissionRule): boolean {
  return left.tool === right.tool
    && left.pathGlob === right.pathGlob
    && left.scope === right.scope
    && left.workspaceRoot === right.workspaceRoot;
}

function isAction(value: string): value is PermissionRule['action'] {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

function isScope(value: string): value is PermissionRule['scope'] {
  return value === 'global' || value === 'workspace';
}
