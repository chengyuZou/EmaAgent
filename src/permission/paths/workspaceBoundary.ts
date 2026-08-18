// 判断原路径与真实路径是否完整落在本次请求声明的工作区内。

import path, { posix } from 'node:path';
import { normalizeCaseForComparison, normalizeMacOsSymlinks, getPathsForPermissionCheck } from './pathSafety.js';
import { getPlatform, toPortablePath } from './platformPaths.js';

/** 返回统一分隔符的跨平台相对路径，供工作区边界比较。 */
function relativePosixPath(from: string, to: string): string {
  if (getPlatform() === 'windows') {
    return posix.relative(toPortablePath(from), toPortablePath(to));
  }
  return posix.relative(from, to);
}

/**
 * 判断目标是否等于或位于工作区内部，同时处理 macOS 路径别名和大小写差异。
 */
export function pathInWorkingDir(targetPath: string, workingDir: string): boolean {
  const platform = getPlatform();

  let normTarget  = path.resolve(targetPath);
  let normWorking = path.resolve(workingDir);

  if (platform === 'macos') {
    normTarget  = normalizeMacOsSymlinks(normTarget);
    normWorking = normalizeMacOsSymlinks(normWorking);
  }

  const ciTarget  = normalizeCaseForComparison(normTarget);
  const ciWorking = normalizeCaseForComparison(normWorking);

  const relative = relativePosixPath(ciWorking, ciTarget);

  if (relative === '') return true;
  if (relative.startsWith('../') || relative === '..') return false;
  return !posix.isAbsolute(relative);
}

/**
 * 原路径和 symlink/junction 真实路径都必须落在工作区内，任一越界都返回 false。
 */
export function pathInAnyWorkingDir(
  targetPath: string,
  context:    { readonly workspaceRoot?: string },
): boolean {
  // 缺少工作区必须直接拒绝，不能让 path.resolve('') 把宿主 cwd 变成隐式授权目录。
  if (!context.workspaceRoot) return false;

  const allPaths = getPathsForPermissionCheck(targetPath);
  const wd       = context.workspaceRoot;

  return allPaths.every(p => pathInWorkingDir(p, wd));
}
