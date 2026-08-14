// Permission 永久规则的窄存储接口与内存实现；SQL 实现由 Storage Repo 和 Server 装配适配。
import { randomUUID } from 'node:crypto';
import type { PermissionRule, PersistedPermissionRule } from '../types.js';

/**
 * Permission 业务需要的永久规则窄存储接口。
 *
 * 生产实现由 Server 用 PermissionRulesRepo 适配（SQL → profile.db.permission_rules）；
 * 测试用 InMemoryPermissionRuleStore。session 级临时授权不进此接口,
 * 由 PermissionEngine 内存 SessionGrantStore 管理。
 */
export interface PermissionRuleStore {
  /** 列出全部持久化规则(含禁用)。 */
  list(): PersistedPermissionRule[];
  /** 只列出启用规则;Engine 加载这些参与匹配。 */
  listEnabled(): PersistedPermissionRule[];
  /** 插入或按 (tool, pathGlob, scope, workspaceRoot) 去重更新;返回持久化结果。 */
  upsert(input: PermissionRule): PersistedPermissionRule;
  /** 启停一条规则。 */
  setEnabled(id: string, enabled: boolean): boolean;
  /** 按 id 删除;不存在返回 false。 */
  delete(id: string): boolean;
}

/** 同 (tool, pathGlob, scope, workspaceRoot) 视为同一条规则(与 SQL 唯一索引一致)。 */
function sameSelector(a: PermissionRule, b: PermissionRule): boolean {
  return a.tool === b.tool
    && a.pathGlob === b.pathGlob
    && a.scope === b.scope
    && a.workspaceRoot === b.workspaceRoot;
}

/** 内存实现:测试与无 DB 环境用。语义与 SQL 唯一索引对齐。 */
export class InMemoryPermissionRuleStore implements PermissionRuleStore {
  private readonly rules = new Map<string, PersistedPermissionRule>();

  list(): PersistedPermissionRule[] {
    return [...this.rules.values()];
  }

  listEnabled(): PersistedPermissionRule[] {
    return this.list().filter(r => r.enabled);
  }

  upsert(input: PermissionRule): PersistedPermissionRule {
    const existing = this.list().find(r => sameSelector(r, input));
    const now = Date.now();
    if (existing) {
      const updated: PersistedPermissionRule = {
        ...existing,
        action: input.action,
        tool: input.tool,
        pathGlob: input.pathGlob,
        scope: input.scope,
        workspaceRoot: input.workspaceRoot,
        updatedAt: now,
      };
      this.rules.set(existing.id, updated);
      return updated;
    }
    const id = randomUUID();
    const persisted: PersistedPermissionRule = {
      ...input,
      id,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(id, persisted);
    return persisted;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const existing = this.rules.get(id);
    if (!existing) return false;
    this.rules.set(id, { ...existing, enabled, updatedAt: Date.now() });
    return true;
  }

  delete(id: string): boolean {
    return this.rules.delete(id);
  }
}
