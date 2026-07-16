// 这里把 Core 传入的真实路径和权限规则整理成各系统沙箱使用的配置。

import { statSync } from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import type { PermissionRule } from '@ema-agent/permission';
import type { SandboxConfig } from './types.js';
import { getPlatform } from './platform.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Files that, if created together in the workspace root, would trick git into
 * treating the directory as a bare repository and executing core.fsmonitor.
 * See: anthropics/claude-code#29316 — "bare-repo escape" attack.
 */
const BARE_REPO_FILES = ['HEAD', 'objects', 'refs', 'hooks', 'config'] as const;

// ── Context ───────────────────────────────────────────────────────────────────

export interface ConfigContext {
  workspaceRoot: string;
  sessionId?:    string;
  /** Core 指定的私有文件或目录，沙箱进程一律不能读取或修改。 */
  protectedPaths: readonly string[];
  /** V1 只有完全断网和全网访问两档。 */
  networkAccess: 'none' | 'full';
}

// ── Builder output ────────────────────────────────────────────────────────────

export interface BuildResult {
  config:     SandboxConfig;
  /**
   * Paths that did NOT exist at config-build time but are inside the workspace.
   * `cleanup()` deletes any of these that appear after a sandboxed command runs,
   * preventing a planted bare-repo escape from surviving into the next git call.
   */
  scrubPaths: string[];
}

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildSandboxConfig(
  rules:   ReadonlyArray<PermissionRule>,
  ctx:     ConfigContext,
): BuildResult {
  // macOS: os.tmpdir() returns /var/folders/… but tools often write to /tmp → /private/tmp.
  // Include both so sandbox doesn't block legitimate temp file usage.
  const macOsTmpExtras = process.platform === 'darwin' ? ['/tmp', '/private/tmp'] : [];

  const allowWrite: string[] = [
    ...(ctx.workspaceRoot ? [path.resolve(ctx.workspaceRoot)] : []),
    os.tmpdir(),
    ...macOsTmpExtras,
  ];
  const denyWrite:  string[] = [];
  const denyRead:   string[] = [];
  const allowRead:  string[] = [];

  // 这些路径由 Core 提供，Sandbox 不再猜 profile 或 data 目录。
  for (const protectedPath of ctx.protectedPaths) {
    const absolutePath = path.resolve(protectedPath);
    if (!denyWrite.includes(absolutePath)) denyWrite.push(absolutePath);
    if (!denyRead.includes(absolutePath)) denyRead.push(absolutePath);
  }

  // Bare-repo attack prevention ───────────────────────────────────────────────
  // A sandboxed command could plant HEAD/objects/refs/hooks/config in the
  // workspace root to trigger the bare-repo escape on the next git call.
  //
  // For files that already exist: add to denyWrite so sandbox mounts them ro.
  // For files that don't exist: record in scrubPaths so cleanup() can delete
  // anything planted during a sandboxed command.
  const scrubPaths: string[] = [];
  if (ctx.workspaceRoot) {
    for (const file of BARE_REPO_FILES) {
      const p = path.resolve(ctx.workspaceRoot, file);
      try {
        statSync(p);            // throws ENOENT if absent
        denyWrite.push(p);      // exists → make it read-only inside sandbox
      } catch {
        scrubPaths.push(p);     // absent → delete if it appears after command
      }
    }
  }

  // Permission rules → sandbox filesystem paths ─────────────────────────────
  for (const rule of rules) {
    if (!rule.pathGlob) continue;

    const base = resolveGlobBase(rule.pathGlob, ctx.workspaceRoot || '');

    if (rule.tool === 'fs-edit' || rule.tool === 'fs-write') {
      if (rule.action === 'allow') allowWrite.push(base);
      else if (rule.action === 'deny') denyWrite.push(base);
    }

    if (rule.tool === 'fs-read') {
      if (rule.action === 'allow') allowRead.push(base);
      else if (rule.action === 'deny') denyRead.push(base);
    }
  }

  return {
    config: {
      filesystem: { allowWrite, denyWrite, denyRead, allowRead },
      network:    { access: ctx.networkAccess },
    },
    scrubPaths,
  };
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * Extract the base directory from a pathGlob so bubblewrap/sandbox-exec can
 * bind-mount it. Strips trailing /** and resolves prefix conventions.
 *
 * Convention (mirrors permission/rules.ts resolvePatternRoot):
 *   //abs/path/**  → /abs/path   (filesystem root anchored)
 *   ~/rel/**       → ~/rel       (home-dir anchored)
 *   /rel/**        → workspaceRoot/rel
 *   rel/**         → workspaceRoot/rel
 */
function resolveGlobBase(glob: string, workspaceRoot: string): string {
  const stripped = glob.endsWith('/**') ? glob.slice(0, -3) : glob;

  if (stripped.startsWith('//')) {
    // Filesystem-root-anchored — mirrors resolvePatternRoot() in permission/rules.ts.
    // On Windows the drive letter comes from the workspace root (same convention).
    if (getPlatform() === 'windows') {
      const drive = workspaceRoot.slice(0, 3) || (process.env['SystemDrive'] ?? 'C:') + '\\';
      return path.join(drive, stripped.slice(2).replace(/\//g, path.sep));
    }
    return stripped.slice(1);   // //abs/path → /abs/path on Linux/macOS
  }

  if (stripped.startsWith('~/')) return path.join(os.homedir(), stripped.slice(2));
  if (stripped.startsWith('/'))  return path.resolve(workspaceRoot, stripped.slice(1));

  return path.resolve(workspaceRoot, stripped.startsWith('./') ? stripped.slice(2) : stripped);
}
