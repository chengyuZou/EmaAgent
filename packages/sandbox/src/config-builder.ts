import { statSync } from 'node:fs';
import { rmSync, existsSync } from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import type { PermissionRule } from '@ema-agent/permission';
import type { SandboxConfig } from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Files that, if created together in the workspace root, would trick git into
 * treating the directory as a bare repository and executing core.fsmonitor.
 * See: anthropics/claude-code#29316 — "bare-repo escape" attack.
 */
const BARE_REPO_FILES = ['HEAD', 'objects', 'refs', 'hooks', 'config'] as const;

// ── Context ───────────────────────────────────────────────────────────────────

export interface ConfigContext {
  workspaceRoot:         string;
  additionalWorkingDirs?: string[];
  sessionId?:            string;
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
  const allowWrite: string[] = [
    path.resolve(ctx.workspaceRoot),
    os.tmpdir(),
    ...(ctx.additionalWorkingDirs ?? []).map(d => path.resolve(d)),
  ];
  const denyWrite:  string[] = [];
  const denyRead:   string[] = [];
  const allowRead:  string[] = [];

  const allowedDomains: string[] = [];
  const deniedDomains:  string[] = [];

  // Always deny writes to EmaAgent settings to prevent sandbox escape
  denyWrite.push(path.join(os.homedir(), '.ema-agent', 'settings.json'));

  // Bare-repo attack prevention ───────────────────────────────────────────────
  // For files that already exist: add to denyWrite so sandbox mounts them ro.
  // For files that don't exist: record in scrubPaths so cleanup() can delete
  // anything planted during a sandboxed command.
  const scrubPaths: string[] = [];
  for (const file of BARE_REPO_FILES) {
    const p = path.resolve(ctx.workspaceRoot, file);
    try {
      statSync(p);            // throws ENOENT if absent
      denyWrite.push(p);      // exists → make it read-only inside sandbox
    } catch {
      scrubPaths.push(p);     // absent → delete if it appears after command
    }
  }

  // Permission rules → sandbox paths / domains ───────────────────────────────
  for (const rule of rules) {
    if (!rule.pathGlob) continue;

    const domainMatch = rule.pathGlob.match(/^domain:(.+)$/);

    if (rule.tool === 'web-fetch' && domainMatch?.[1]) {
      if (rule.action === 'allow') allowedDomains.push(domainMatch[1]);
      else if (rule.action === 'deny') deniedDomains.push(domainMatch[1]);
      continue;
    }

    const base = resolveGlobBase(rule.pathGlob, ctx.workspaceRoot);

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
      network:    { allowedDomains, deniedDomains },
    },
    scrubPaths,
  };
}

// ── Post-command cleanup ──────────────────────────────────────────────────────

/**
 * Delete any bare-repo files that were planted during a sandboxed command.
 * Must be called synchronously after every sandboxed command completes,
 * before the next (potentially unsandboxed) git call.
 */
export function scrubPlantedFiles(scrubPaths: string[]): void {
  for (const p of scrubPaths) {
    if (!existsSync(p)) continue;
    try {
      rmSync(p, { recursive: true });
    } catch {
      // ENOENT or permission error — not planted or already cleaned
    }
  }
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

  if (stripped.startsWith('//')) return stripped.slice(1);   // //abs → /abs
  if (stripped.startsWith('~/')) return path.join(os.homedir(), stripped.slice(2));
  if (stripped.startsWith('/'))  return path.resolve(workspaceRoot, stripped.slice(1));

  return path.resolve(workspaceRoot, stripped.startsWith('./') ? stripped.slice(2) : stripped);
}
