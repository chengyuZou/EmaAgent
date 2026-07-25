import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PermissionContext, ToolPermissionMeta } from '../types.js';

/**
 * “本会话允许”的精确授权描述。
 *
 * Session 授权不能退化成只按工具名匹配，否则一次 shell 审批会放行该
 * Session 中所有后续命令。这里把工作区、规范化工具输入和权限能力一并
 * 纳入指纹，后续只有完全相同的操作才能复用授权。
 */
export interface SessionGrantAction {
  toolName: string;
  input: unknown;
  meta: ToolPermissionMeta;
  /** 审批时解析出的原始路径与真实路径，防止符号链接换目标后复用旧授权。 */
  resolvedPaths: readonly string[];
  context: Pick<PermissionContext, 'workspaceRoot'>;
}

/** PermissionEngine 内部使用的 Session 生命周期授权缓存。 */
export class SessionGrantStore {
  private readonly grantsBySession = new Map<string, Set<string>>();

  has(sessionId: string | undefined, action: SessionGrantAction): boolean {
    if (!sessionId) return false;
    return this.grantsBySession.get(sessionId)?.has(fingerprint(action)) ?? false;
  }

  allow(sessionId: string, action: SessionGrantAction): void {
    let grants = this.grantsBySession.get(sessionId);
    if (!grants) {
      grants = new Set<string>();
      this.grantsBySession.set(sessionId, grants);
    }
    grants.add(fingerprint(action));
  }

  clear(sessionId: string): void {
    this.grantsBySession.delete(sessionId);
  }
}

function fingerprint(action: SessionGrantAction): string {
  const workspaceRoot = action.context.workspaceRoot
    ? path.resolve(action.context.workspaceRoot)
    : '';
  const canonical = canonicalJson({
    toolName: action.toolName,
    workspaceRoot,
    input: action.input,
    resolvedPaths: action.resolvedPaths.map(item => path.resolve(item)).sort(),
    accessType: action.meta.accessType ?? null,
    riskLevel: action.meta.riskLevel ?? null,
    bypassImmune: action.meta.bypassImmune ?? false,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 仅接受工具 Schema 应产出的 JSON 数据，并稳定排序对象键。 */
function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return '{"$emaType":"undefined"}';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Permission input contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Permission input contains unsupported value: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError('Permission input contains a circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalJson(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Permission input must contain plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
