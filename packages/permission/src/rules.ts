import { createRequire } from 'node:module';
import os        from 'node:os';
import path      from 'node:path';
import { posix } from 'node:path';
import type { Ignore } from 'ignore';
import type { PermissionRule, RuleScope, PermissionContext } from './types.js';
import { normalizeCaseForComparison } from './path-safety.js';
import { getPlatform } from './platform.js';

// CJS interop: `ignore` uses `export =` which NodeNext ESM cannot import as default.
const _req = createRequire(import.meta.url);
const createIgnore = _req('ignore') as () => Ignore;
// TYPE-04: guard against packaging failures that would turn this into a silent runtime error
if (typeof createIgnore !== 'function') {
  throw new Error('@ema-agent/permission: failed to load the "ignore" package — is it installed?');
}

// ── Ignore-instance cache ─────────────────────────────────────────────────────
// Building an Ignore instance for the same pattern on every tool call is wasteful
// when a session has many calls. Cache by normalised pattern string (module-level,
// shared across sessions — safe because patterns are deterministic pure strings).
const _ignoreCache = new Map<string, Ignore>();

function getIgnore(pattern: string): Ignore {
  let ig = _ignoreCache.get(pattern);
  if (!ig) {
    ig = createIgnore().add([pattern]);
    _ignoreCache.set(pattern, ig);
  }
  return ig;
}

/** Clear ignore cache — exposed for unit tests that mutate patterns. */
export function clearIgnoreCache(): void {
  _ignoreCache.clear();
}

// ── POSIX path conversion ─────────────────────────────────────────────────────
// NOTE: workspace.ts has an identical helper — kept separate intentionally so
// each file remains independently importable without cross-dependencies.

function toPosix(p: string): string {
  return getPlatform() === 'windows' ? p.replace(/\\/g, '/') : p;
}

// ── Pattern root resolution ───────────────────────────────────────────────────

/**
 * Determines the filesystem root for a rule's pathGlob based on its prefix,
 * and returns the pattern root-relative (no leading slash) so `ignore` can
 * match it correctly.
 *
 * ```
 * Pattern prefixes:
 *   //abs/path/**  → anchored to filesystem root (/ on Unix, drive root on Windows)
 *   ~/rel/**       → anchored to home directory
 *   /rel/**        → anchored to scope root (workspaceRoot for session/project, ~ for global)
 *   rel/**         → same as /rel (relative to scope root)
 *   ./rel/**       → normalised to rel
 * ```
 * @example
 * resolvePatternRoot("/src/**", "session", "/Users/abc/project")
 * => {
 *   root: "/Users/abc/project",
 *   pattern: "src/**"
 * }
 * 
 */
function resolvePatternRoot(
  glob:          string,
  scope:         RuleScope,
  workspaceRoot: string,
): { root: string; pattern: string } {
  const home = os.homedir();

  if (glob.startsWith('//')) {
    // BUG-01 fix: strip both leading slashes so pattern is root-relative
    const fsRoot = getPlatform() === 'windows'
      ? workspaceRoot.slice(0, 3) || (process.env['SystemDrive'] ?? 'C:') + '\\'
      : '/';
    return { root: fsRoot, pattern: glob.slice(2) };
  }

  if (glob.startsWith('~/') || glob === '~') {
    return { root: home, pattern: glob.slice(2) };
  }

  const scopeRoot = scope === 'global' ? home : workspaceRoot;

  if (glob.startsWith('/')) {
    // BUG-02 fix: strip leading / so pattern is root-relative, not scope-relative with a slash
    return { root: scopeRoot, pattern: glob.slice(1) };
  }

  // Relative — strip leading ./
  const pattern = glob.startsWith('./') ? glob.slice(2) : glob;
  return { root: scopeRoot, pattern };
}

// ── Pattern matching via `ignore` ─────────────────────────────────────────────

/**
 * Returns true if `targetPath` matches the rule's pathGlob using gitignore
 * semantics (via the `ignore` npm library).
 */
function pathMatchesGlob(
  targetPath:    string,
  glob:          string,
  scope:         RuleScope,
  context:       Pick<PermissionContext, 'workspaceRoots'>,
): boolean {
  const { root, pattern } = resolvePatternRoot(glob, scope, context.workspaceRoots[0] ?? '');

  const posixTarget = toPosix(path.resolve(targetPath));
  const posixRoot   = toPosix(path.resolve(root));

  const relative = posix.relative(posixRoot, posixTarget);

  // Target is outside root — cannot match
  if (relative.startsWith('..') || posix.isAbsolute(relative)) return false;
  // Empty string means target IS the root itself — not matchable by a file pattern
  if (!relative) return false;

  // Strip trailing /** — `ignore` implicitly matches the whole subtree
  const normalised = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (!normalised) return false;

  return getIgnore(normalised).ignores(relative);
}

// ── Rule matching ─────────────────────────────────────────────────────────────

export function ruleMatches(
  rule:       PermissionRule,
  toolName:   string,
  targetPath: string | undefined,
  context:    Pick<PermissionContext, 'workspaceRoots'>,
): boolean {
  if (rule.tool !== '*' && normalizeCaseForComparison(rule.tool) !== normalizeCaseForComparison(toolName)) {
    return false;
  }
  if (rule.pathGlob === undefined) return true;
  if (targetPath === undefined)    return false;
  return pathMatchesGlob(targetPath, rule.pathGlob, rule.scope, context);
}

// ── Rule lookup helpers ───────────────────────────────────────────────────────

export function findDenyRule(
  rules: PermissionRule[], toolName: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoots'>,
): PermissionRule | undefined {
  return rules.find(r => r.action === 'deny' && ruleMatches(r, toolName, targetPath, context));
}

export function findAskRule(
  rules: PermissionRule[], toolName: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoots'>,
): PermissionRule | undefined {
  return rules.find(r => r.action === 'ask' && ruleMatches(r, toolName, targetPath, context));
}

export function findAllowRule(
  rules: PermissionRule[], toolName: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoots'>,
): PermissionRule | undefined {
  return rules.find(r => r.action === 'allow' && ruleMatches(r, toolName, targetPath, context));
}

// ── Rule persistence helper ───────────────────────────────────────────────────

export function upsertRule(rules: PermissionRule[], incoming: PermissionRule): PermissionRule[] {
  const filtered = rules.filter(
    r => !(
      normalizeCaseForComparison(r.tool) === normalizeCaseForComparison(incoming.tool) &&
      r.pathGlob === incoming.pathGlob &&
      r.scope    === incoming.scope
    ),
  );
  return [...filtered, incoming];
}
