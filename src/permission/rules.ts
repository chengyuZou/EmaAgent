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

  // No workspace (subagents pass ''). Session/project-scoped relative or
  // `/`-prefixed patterns anchor to the workspace — without one they cannot
  // match. Return empty so pathMatchesGlob short-circuits to false instead of
  // falling back to path.resolve('') = process.cwd() (which would let a
  // subagent match rules against the sidecar's cwd). `~/` and `//` patterns
  // already returned above (home / fs-root anchored, workspace-independent).
  if (!scopeRoot) return { root: '', pattern: '' };

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
  context:       Pick<PermissionContext, 'workspaceRoot'>,
): boolean {
  const { root, pattern } = resolvePatternRoot(glob, scope, context.workspaceRoot || '');

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
  context:    Pick<PermissionContext, 'workspaceRoot' | 'sessionId'>,
): boolean {
  if (rule.scope === 'session' && (!rule.sessionId || rule.sessionId !== context.sessionId)) {
    return false;
  }
  if (rule.tool !== '*' && normalizeCaseForComparison(rule.tool) !== normalizeCaseForComparison(toolName)) {
    return false;
  }
  if (rule.pathGlob === undefined) return true;
  if (targetPath === undefined)    return false;
  return pathMatchesGlob(targetPath, rule.pathGlob, rule.scope, context);
}

// ── Rule lookup helpers ───────────────────────────────────────────────────────

/**
 * Scope 优先级：global > project > session。
 * 持久全局规则最权威，项目配置次之，Session 临时规则最低。
 * 同一 action 的多条规则都匹配同一调用时，按此优先级返回确定的那条，
 * 使审计能准确指出放行/拒绝来自哪一层，而不是依赖 rules 数组注入顺序。
 */
const SCOPE_PRIORITY: Record<RuleScope, number> = {
  global:  0,
  project: 1,
  session: 2,
};

function compareScopePriority(left: PermissionRule, right: PermissionRule): number {
  return SCOPE_PRIORITY[left.scope] - SCOPE_PRIORITY[right.scope];
}

/**
 * 在同一 action 的规则里查找匹配项，按 scope 优先级返回最权威的那条。
 * deny/ask/allow 各自的 Step 顺序仍由 PermissionEngine.gate() 保证，
 * 这里只决定同 action 内多规则匹配时返回哪一条用于审计与决策归因。
 */
function findRuleByAction(
  rules:       PermissionRule[],
  action:      PermissionRule['action'],
  toolName:    string,
  targetPath:  string | undefined,
  context:     Pick<PermissionContext, 'workspaceRoot' | 'sessionId'>,
): PermissionRule | undefined {
  const matched = rules.filter(
    r => r.action === action && ruleMatches(r, toolName, targetPath, context),
  );
  if (matched.length === 0) return undefined;
  matched.sort(compareScopePriority);
  return matched[0];
}

export function findDenyRule(
  rules: PermissionRule[], toolName: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoot' | 'sessionId'>,
): PermissionRule | undefined {
  return findRuleByAction(rules, 'deny', toolName, targetPath, context);
}

export function findAskRule(
  rules: PermissionRule[], toolName: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoot' | 'sessionId'>,
): PermissionRule | undefined {
  return findRuleByAction(rules, 'ask', toolName, targetPath, context);
}

export function findAllowRule(
  rules: PermissionRule[], toolName: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoot' | 'sessionId'>,
): PermissionRule | undefined {
  return findRuleByAction(rules, 'allow', toolName, targetPath, context);
}

// ── Rule persistence helper ───────────────────────────────────────────────────

export function upsertRule(rules: PermissionRule[], incoming: PermissionRule): PermissionRule[] {
  const filtered = rules.filter(
    r => !(
      normalizeCaseForComparison(r.tool) === normalizeCaseForComparison(incoming.tool) &&
      r.pathGlob === incoming.pathGlob &&
      r.scope    === incoming.scope &&
      r.sessionId === incoming.sessionId
    ),
  );
  return [...filtered, incoming];
}
