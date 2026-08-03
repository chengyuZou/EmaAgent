// 为批准复核与 Session 临时授权生成同一份稳定请求指纹。

import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  PermissionIntent,
  PermissionMode,
  PermissionPathAccess,
} from './types.js';

export interface ResolvedPermissionTarget {
  readonly requestedPath: string;
  readonly accessType: PermissionPathAccess;
  readonly resolvedPaths: readonly string[];
}

export interface PermissionFingerprintInput {
  readonly toolId: string;
  readonly input: unknown;
  readonly intent: PermissionIntent;
  readonly mode: PermissionMode;
  readonly workspaceRoot?: string;
  readonly resolvedTargets: readonly ResolvedPermissionTarget[];
  readonly internalPathRoot?: string;
}

/**
 * 指纹只描述授权语义，不包含 Turn、ToolCall 等动态身份。
 * 这样相同操作才能复用 Session Grant，同时工作区或真实路径变化会让旧授权失效。
 */
export function createPermissionRequestFingerprint(
  request: PermissionFingerprintInput,
): string {
  const canonical = canonicalJson({
    toolId: request.toolId,
    input: request.input,
    mode: request.mode,
    intent: {
      riskLevel: request.intent.riskLevel,
      accessType: request.intent.accessType,
      promptPolicy: request.intent.promptPolicy,
      internalPathCapability: request.intent.internalPathCapability ?? null,
    },
    workspaceRoot: request.workspaceRoot
      ? path.resolve(request.workspaceRoot)
      : null,
    internalPathRoot: request.internalPathRoot
      ? path.resolve(request.internalPathRoot)
      : null,
    resolvedTargets: request.resolvedTargets
      .map(target => ({
        requestedPath: target.requestedPath,
        accessType: target.accessType,
        resolvedPaths: target.resolvedPaths
          .map(candidate => path.resolve(candidate))
          .sort(),
      }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Prepared Tool 输入只允许 JSON 数据；稳定排序对象键，避免键顺序改变授权结果。 */
function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return '{"$emaType":"undefined"}';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Permission 请求包含非有限数字');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Permission 请求包含不支持的值：${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError('Permission 请求包含循环引用');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalJson(item, seen)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Permission 请求只能包含普通 JSON 对象');
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
