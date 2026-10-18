import { createRequire } from 'node:module';
import type { Ignore } from 'ignore';
import { normalizeCaseForComparison } from '../paths/pathSafety.js';

// ignore 是 CJS 包; NodeNext ESM 下经 createRequire 取工厂函数.
const require = createRequire(import.meta.url);
const ignore = require('ignore') as (options?: { ignorecase?: boolean }) => Ignore;

const matcherCache = new Map<string, Ignore>();

export function filePathToRuleContent(absolutePath: string): string {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}

export function directoryPathToRuleContent(absolutePath: string): string {
  return `directory:${absolutePath.replace(/\\/g, '/')}`;
}

function matcherFor(ruleContent: string): Ignore {
  let matcher = matcherCache.get(ruleContent);
  if (!matcher) {
    matcher = ignore().add(ruleContent);
    matcherCache.set(ruleContent, matcher);
  }
  return matcher;
}

/**
 * file:/directory: 按字面路径匹配, 不展开文件名中的模式字符.
 * 其他规则使用 gitignore 语义: // 开头按绝对路径匹配, 其余相对 cwd 匹配.
 * ignore 只接收相对候选路径, 因此绝对路径先转换盘符并移除候选的前导斜杠.
 */
export function matchPathRule(
  ruleContent: string,
  candidatePath: string,
  cwd?: string,
): boolean {
  // 本会话批准保存字面路径, 不把文件名中的模式字符解释成更大范围.
  if (ruleContent.startsWith('file:')) {
    return normalizeCaseForComparison(toPosixDrive(ruleContent.slice(5)))
      === normalizeCaseForComparison(toPosixDrive(candidatePath));
  }
  if (ruleContent.startsWith('directory:')) {
    const directory = normalizeCaseForComparison(toPosixDrive(ruleContent.slice(10))).replace(/\/+$/, '');
    const candidate = normalizeCaseForComparison(toPosixDrive(candidatePath));
    return candidate === directory || candidate.startsWith(directory + '/');
  }
  if (ruleContent.startsWith('//')) {
    const absoluteRule = toPosixDrive(ruleContent.slice(1).replace(/^\/+/, ''));
    const target = toPosixDrive(candidatePath).replace(/^\/+/, '');
    return matcherFor(absoluteRule).ignores(target);
  }

  if (!cwd) return false;
  const posixRoot = toPosixDrive(cwd).replace(/\/+$/, '');
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
 * 统一分隔符, 将 Windows 盘符改为 /x/ 形式.
 * 调用方再移除根或前导斜杠, 避免将带盘符的绝对路径直接交给 ignore.
 */
function toPosixDrive(candidate: string): string {
  const posix = candidate.replace(/\\/g, '/');
  const drive = posix.match(/^([A-Za-z]):\//);
  return drive ? `/${drive[1]!.toLowerCase()}/${posix.slice(3)}` : posix;
}
