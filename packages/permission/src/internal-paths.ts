import os   from 'node:os';
import path  from 'node:path';
import { normalizeCaseForComparison } from './path-safety.js';
import type { PermissionContext } from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function emaHome(): string {
  return path.join(os.homedir(), '.ema');
}

function normalize(p: string): string {
  return path.normalize(p);
}

function underDir(normalizedPath: string, dir: string): boolean {
  const nd = normalizeCaseForComparison(normalize(dir));
  const np = normalizeCaseForComparison(normalizedPath);
  return np === nd || np.startsWith(nd + path.sep);
}

// ── Internal path definitions ─────────────────────────────────────────────────

/**
 * Session memory: ~/.ema/sessions/{sessionId}/memory/
 * The agent writes summaries and notes here across turns.
 */
function sessionMemoryDir(sessionId: string): string {
  return path.join(emaHome(), 'sessions', sessionId, 'memory');
}

/**
 * Artifact output directory: ~/.ema/sessions/{sessionId}/artifacts/
 * Tools write generated files (images, PPT, code) here.
 */
function artifactDir(sessionId: string): string {
  return path.join(emaHome(), 'sessions', sessionId, 'artifacts');
}

/**
 * Scratchpad: ~/.ema/sessions/{sessionId}/scratch/
 * Temporary files for the agent's own use during a session.
 */
function scratchpadDir(sessionId: string): string {
  return path.join(emaHome(), 'sessions', sessionId, 'scratch');
}

/**
 * Project-level sessions directory: ~/.ema/sessions/
 * Readable by the agent for cross-session memory recall.
 */
function sessionsRoot(): string {
  return path.join(emaHome(), 'sessions');
}

// ── Carve-out checks ──────────────────────────────────────────────────────────

/**
 * Returns 'allow' if the path is an internal EmaAgent path that the agent
 * may WRITE without going through the normal permission flow.
 * Returns 'passthrough' to continue normal permission evaluation.
 *
 * Must be called BEFORE the dangerous-dir check so that paths under
 * .ema/ (which is in DANGEROUS_DIRS) are not blocked.
 */
export function checkEditableInternalPath(
  absolutePath: string,
  context: Pick<PermissionContext, 'sessionId'>,
): 'allow' | 'passthrough' {
  const np = normalizeCaseForComparison(normalize(absolutePath));

  if (context.sessionId) {
    // Session memory, artifacts, and scratchpad are all writable
    if (underDir(np, sessionMemoryDir(context.sessionId))) return 'allow';
    if (underDir(np, artifactDir(context.sessionId)))      return 'allow';
    if (underDir(np, scratchpadDir(context.sessionId)))    return 'allow';
  }

  return 'passthrough';
}

/**
 * Returns 'allow' if the path is an internal EmaAgent path that the agent
 * may READ without going through the normal permission flow.
 * Returns 'passthrough' to continue normal permission evaluation.
 */
export function checkReadableInternalPath(
  absolutePath: string,
  context: Pick<PermissionContext, 'sessionId'>,
): 'allow' | 'passthrough' {
  const np = normalizeCaseForComparison(normalize(absolutePath));

  // Only the current session's own directories are auto-readable.
  // Cross-session memory recall must go through the memory package's
  // MemoryPlanner, not through an open path carve-out.
  if (context.sessionId) {
    if (underDir(np, sessionMemoryDir(context.sessionId))) return 'allow';
    if (underDir(np, artifactDir(context.sessionId)))      return 'allow';
    if (underDir(np, scratchpadDir(context.sessionId)))    return 'allow';
  }

  return 'passthrough';
}

// ── Exported path accessors (for use by other packages) ──────────────────────

export { sessionMemoryDir, artifactDir, scratchpadDir, sessionsRoot, emaHome };
