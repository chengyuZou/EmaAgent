// 这里检查一个路径是否位于 Core 传进来的内部工作目录中。

import path from 'node:path';
import { normalizeCaseForComparison } from './path-safety.js';
import type { PermissionContext } from './types.js';

function normalize(candidate: string): string {
  return path.normalize(candidate);
}

function underDir(normalizedPath: string, root: string): boolean {
  const normalizedRoot = normalizeCaseForComparison(normalize(root));
  const candidate = normalizeCaseForComparison(normalizedPath);
  return candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep);
}

function grantedRoots(context: Pick<PermissionContext, 'internalPaths'>): string[] {
  return Object.values(context.internalPaths ?? {}).filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
}

/** 判断路径是否位于本次执行被显式授予的可写内部目录中。 */
export function checkEditableInternalPath(
  absolutePath: string,
  context: Pick<PermissionContext, 'internalPaths'>,
): 'allow' | 'passthrough' {
  const candidate = normalizeCaseForComparison(normalize(absolutePath));
  return grantedRoots(context).some(root => underDir(candidate, root))
    ? 'allow'
    : 'passthrough';
}

/** 判断路径是否位于本次执行被显式授予的可读内部目录中。 */
export function checkReadableInternalPath(
  absolutePath: string,
  context: Pick<PermissionContext, 'internalPaths'>,
): 'allow' | 'passthrough' {
  const candidate = normalizeCaseForComparison(normalize(absolutePath));
  return grantedRoots(context).some(root => underDir(candidate, root))
    ? 'allow'
    : 'passthrough';
}
