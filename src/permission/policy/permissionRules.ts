// 使用稳定的 gitignore 语义匹配全局与工作区 Permission 规则。

import { createRequire } from 'node:module';
import os        from 'node:os';
import path      from 'node:path';
import { posix } from 'node:path';
import type { Ignore } from 'ignore';
import type { PermissionRule, RuleScope, PermissionContext } from '../types.js';
import { normalizeCaseForComparison } from '../paths/pathSafety.js';
import { getPlatform, toPortablePath } from '../paths/platformPaths.js';

const require = createRequire(import.meta.url);
const createIgnore = require('ignore') as () => Ignore;
if (typeof createIgnore !== 'function') {
  throw new Error('@ema-agent/permission 无法加载 ignore 依赖');
}

const ignoreCache = new Map<string, Ignore>();

function getIgnore(pattern: string): Ignore {
  let matcher = ignoreCache.get(pattern);
  if (!matcher) {
    matcher = createIgnore().add([pattern]);
    ignoreCache.set(pattern, matcher);
  }
  return matcher;
}

export function clearIgnoreCache(): void {
  ignoreCache.clear();
}

/**
 * 按 pathGlob 前缀确定规则根目录，并返回没有前导斜杠的根内 pattern。
 *
 * //abs/path/** 锚定文件系统根(Windows 取工作区盘符根);
 * ~/rel/** 锚定 home;
 * /rel/**、rel/**、./rel/** 锚定 scope 根:
 * global 规则锚 home,workspace 规则锚 workspaceRoot。
 */
function resolvePatternRoot(
  glob:          string,
  scope:         RuleScope,
  workspaceRoot: string,
): { root: string; pattern: string } {
  const home = os.homedir();

  if (glob.startsWith('//')) {
    // 去掉两个前导斜杠后，pattern 才是文件系统根的相对路径。
    const fsRoot = getPlatform() === 'windows'
      ? workspaceRoot.slice(0, 3) || (process.env['SystemDrive'] ?? 'C:') + '\\'
      : '/';
    return { root: fsRoot, pattern: glob.slice(2) };
  }

  if (glob.startsWith('~/') || glob === '~') {
    return { root: home, pattern: glob.slice(2) };
  }

  const scopeRoot = scope === 'global' ? home : workspaceRoot;

  // workspace 规则缺少工作区时不能回退到宿主 cwd；home 与文件系统根前缀已在上方处理。
  if (!scopeRoot) return { root: '', pattern: '' };

  if (glob.startsWith('/')) {
    // ignore 接收根内相对 pattern，必须去掉前导斜杠。
    return { root: scopeRoot, pattern: glob.slice(1) };
  }

  // 相对规则统一去掉 ./。
  const pattern = glob.startsWith('./') ? glob.slice(2) : glob;
  return { root: scopeRoot, pattern };
}

/** 使用 gitignore 语义判断目标路径是否匹配规则。 */
function pathMatchesGlob(
  targetPath:    string,
  glob:          string,
  scope:         RuleScope,
  context:       Pick<PermissionContext, 'workspaceRoot'>,
): boolean {
  const { root, pattern } = resolvePatternRoot(glob, scope, context.workspaceRoot ?? '');

  if (!root || !pattern) return false;

  const posixTarget = toPortablePath(path.resolve(targetPath));
  const posixRoot   = toPortablePath(path.resolve(root));

  const relative = posix.relative(posixRoot, posixTarget);

  if (relative.startsWith('..') || posix.isAbsolute(relative)) return false;
  // 空相对路径代表目标就是锚定根本身:gitignore 无法表达"根本身",
  // 根的管辖权属于 scope 一致性检查,不属于文件 pattern。
  if (!relative) return false;

  // ignore 已隐式匹配子树，去掉结尾 /** 可避免目录本身漏匹配。
  const normalised = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (!normalised) return false;

  // Windows 路径的真实路径与大小写候选由上游路径解析统一提供；本层只执行确定的 gitignore 匹配。
  return getIgnore(normalised).ignores(relative);
}

export function ruleMatches(
  rule:       PermissionRule,
  toolId:     string,
  targetPath: string | undefined,
  context:    Pick<PermissionContext, 'workspaceRoot'>,
): boolean {
  if (rule.scope === 'workspace') {
    if (!rule.workspaceRoot || !context.workspaceRoot) return false;
    if (normalizeCaseForComparison(rule.workspaceRoot) !== normalizeCaseForComparison(context.workspaceRoot)) return false;
  }
  if (rule.tool !== '*' && normalizeCaseForComparison(rule.tool) !== normalizeCaseForComparison(toolId)) {
    return false;
  }
  if (rule.pathGlob === undefined) return true;
  if (targetPath === undefined)    return false;
  return pathMatchesGlob(targetPath, rule.pathGlob, rule.scope, context);
}


const SCOPE_PRIORITY: Record<RuleScope, number> = {
  global:    0,
  workspace: 1,
};

function compareScopePriority(left: PermissionRule, right: PermissionRule): number {
  return SCOPE_PRIORITY[left.scope] - SCOPE_PRIORITY[right.scope];
}


function findRuleByAction(
  rules:       PermissionRule[],
  action:      PermissionRule['action'],
  toolId:      string,
  targetPath:  string | undefined,
  context:     Pick<PermissionContext, 'workspaceRoot'>,
): PermissionRule | undefined {
  const matched = rules.filter(
    r => r.action === action && ruleMatches(r, toolId, targetPath, context),
  );
  if (matched.length === 0) return undefined;
  matched.sort(compareScopePriority);
  return matched[0];
}

export function findDenyRule(
  rules: PermissionRule[], toolId: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoot'>,
): PermissionRule | undefined {
  return findRuleByAction(rules, 'deny', toolId, targetPath, context);
}

export function findAskRule(
  rules: PermissionRule[], toolId: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoot'>,
): PermissionRule | undefined {
  return findRuleByAction(rules, 'ask', toolId, targetPath, context);
}

export function findAllowRule(
  rules: PermissionRule[], toolId: string, targetPath: string | undefined,
  context: Pick<PermissionContext, 'workspaceRoot'>,
): PermissionRule | undefined {
  return findRuleByAction(rules, 'allow', toolId, targetPath, context);
}
