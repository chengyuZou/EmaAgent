// 检查一个路径是否位于 Core 传进来的内部工作目录中。

import path from 'node:path';
import { normalizeCaseForComparison } from './pathSafety.js';

/** 宿主按 Turn 授予的内部工作目录（如 scratchpad）；键为能力名，值为目录绝对路径。 */
export interface InternalPathRoots {
  readonly internalPaths?: Readonly<Record<string, string | undefined>>;
}

function normalize(candidate: string): string {
  return path.normalize(candidate);
}

function underDir(normalizedPath: string, root: string): boolean {
  const normalizedRoot = normalizeCaseForComparison(normalize(root));
  const candidate = normalizeCaseForComparison(normalizedPath);
  return candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep);
}

function grantedRoots(context: InternalPathRoots): string[] {
  return Object.values(context.internalPaths ?? {}).filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
}

export function checkInternalPath(
  absolutePath: string,
  context: InternalPathRoots,
): 'allow' | 'passthrough' {
  const candidate = normalizeCaseForComparison(normalize(absolutePath));
  return grantedRoots(context).some(root => underDir(candidate, root))
    ? 'allow'
    : 'passthrough';
}

