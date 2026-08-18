// 路径规则（gitignore 语义）与候选路径的匹配；文件 Tool 家族的 checkPermissions 消费。
// 规则形态：'./src/**'（工作区相对）、'src/**'（同义）、'//abs/path/**'（绝对路径，双斜杠前缀）。
import { createRequire } from 'node:module';
import type { Ignore } from 'ignore';

// ignore 是 CJS 包；NodeNext ESM 下经 createRequire 取工厂函数。
const require = createRequire(import.meta.url);
const ignore = require('ignore') as (options?: { ignorecase?: boolean }) => Ignore;

const matcherCache = new Map<string, Ignore>();

function matcherFor(ruleContent: string): Ignore {
  let matcher = matcherCache.get(ruleContent);
  if (!matcher) {
    matcher = ignore().add(ruleContent);
    matcherCache.set(ruleContent, matcher);
  }
  return matcher;
}

/**
 * 单条路径规则命中判定。
 * 绝对路径规则（'//' 前缀）与工作区相对规则分开处理：
 * - '//abs/path/**'：规则与候选统一归一为无冒号 POSIX 盘符形（X:/ → /x/，
 *   候选再剥前导 '/' 折算为相对路径——
 *   ignore 包只接受相对路径，Windows 盘符直接喂库必炸；
 * - './src/**' 或 'src/**'：候选先折算为相对 workspaceRoot 的路径；无 workspaceRoot 不命中。
 */
export function matchPathRule(
  ruleContent: string,
  candidatePath: string,
  workspaceRoot?: string,
): boolean {
  if (ruleContent.startsWith('//')) {
    const absoluteRule = toPosixDrive(ruleContent.slice(1).replace(/^\/+/, ''));
    const target = toPosixDrive(candidatePath).replace(/^\/+/, '');
    return matcherFor(absoluteRule).ignores(target);
  }

  if (!workspaceRoot) return false;
  const posixRoot = toPosixDrive(workspaceRoot).replace(/\/+$/, '');
  const posixCandidate = toPosixDrive(candidatePath);
  if (posixCandidate !== posixRoot && !posixCandidate.startsWith(posixRoot + '/')) {
    return false;
  }
  const relative = posixCandidate === posixRoot
    ? '.'
    : posixCandidate.slice(posixRoot.length + 1);
  const rule = ruleContent.startsWith('./') ? ruleContent.slice(2) : ruleContent;
  return matcherFor(rule).ignores(relative);
}

/**
 * 归一为 POSIX 形式：反斜杠转正，Windows 盘符 X:/ 或 X:\ 转 /x/（无冒号）。
 * ignore 包的绝对路径校验按宿主 path.isAbsolute 判定，Windows 下带盘符必炸；
 * /x/ 形式在任意宿主上都不是"盘符绝对路径"。
 */
function toPosixDrive(candidate: string): string {
  const posix = candidate.replace(/\\/g, '/');
  const drive = posix.match(/^([A-Za-z]):\//);
  return drive ? `/${drive[1]!.toLowerCase()}/${posix.slice(3)}` : posix;
}
