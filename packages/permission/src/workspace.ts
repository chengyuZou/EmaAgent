import path, { posix } from 'node:path';
import { normalizeCaseForComparison, normalizeMacOsSymlinks, getPathsForPermissionCheck } from './path-safety.js';
import { getPlatform } from './platform.js';
import type { PermissionContext } from './types.js';

// ── POSIX conversion ──────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return getPlatform() === 'windows' ? p.replace(/\\/g, '/') : p;
}

// ── Relative path helper ──────────────────────────────────────────────────────

/**
 * Cross-platform relative path that always returns POSIX-style output.
 * Mirrors Claude Code's relativePath() helper.
 */
function relativePosixPath(from: string, to: string): string {
  if (getPlatform() === 'windows') {
    return posix.relative(toPosix(from), toPosix(to));
  }
  return posix.relative(from, to);
}

// ── Single working-dir check ──────────────────────────────────────────────────

/**
 * Returns true if `targetPath` is inside (or equal to) `workingDir`.
 *
 * Handles:
 *  - macOS /private/tmp → /tmp alias normalisation
 *  - Case-insensitive comparison (macOS / Windows)
 *  - Path traversal detection
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

  // Same path
  if (relative === '') return true;

  // Path traversal detected — outside workingDir
  if (relative.startsWith('../') || relative === '..') return false;

  // Is a relative sub-path inside workingDir (not absolute)
  return !posix.isAbsolute(relative);
}

// ── All working dirs check ────────────────────────────────────────────────────

/**
 * Returns true if ALL resolved forms of `targetPath` lie inside at least one
 * of the allowed working directories.
 *
 * Checking ALL resolved forms (original + symlink) prevents symlink escape:
 *   ln -s /etc/passwd /workspace/.env
 * The symlink resolves outside the workspace, so this returns false.
 */
export function pathInAnyWorkingDir(
  targetPath: string,
  context:    Pick<PermissionContext, 'workspaceRoot' | 'additionalWorkingDirs'>,
): boolean {
  const allPaths = getPathsForPermissionCheck(targetPath);

  const workingDirs = [
    context.workspaceRoot,
    ...(context.additionalWorkingDirs ?? []),
  ];

  // Every resolved form must be inside some working dir
  return allPaths.every(p =>
    workingDirs.some(wd => pathInWorkingDir(p, wd)),
  );
}
