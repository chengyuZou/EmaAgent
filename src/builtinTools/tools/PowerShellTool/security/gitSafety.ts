// Git 内部路径(.git/hooks、裸仓库 HEAD 等)判定,防御借 git 机制的沙箱逃逸。
// 对照移植自 Claude packages/builtin-tools/src/tools/PowerShellTool/gitSafety.ts。
// Git 可经两种途径被武器化用于沙箱逃逸:
// 1. 裸仓库攻击:cwd 含有 HEAD + objects/ + refs/ 但无合法 .git/HEAD 时,
//    Git 把 cwd 当作裸仓库,并运行 cwd 里的 hooks。
// 2. Git 内部写 + git:复合命令先创建 HEAD/objects/refs/hooks/,再运行
//    git——git 子命令会执行刚创建的恶意 hooks。

import { basename, posix, resolve, sep } from 'node:path';
import { PS_TOKENIZER_DASH_CHARS } from '../psParser.js';

/**
 * 若规范化路径以 `../<cwd-basename>/` 开头,它经父目录重新进入 cwd——
 * 把它解析为 cwd 相对形式。posix.normalize 保留开头的 `..`(没有 cwd
 * 上下文),因此 cwd=/x/project 时 `../project/hooks` 保持
 * `../project/hooks`,错过 `hooks/` 前缀匹配,尽管运行时它解析到同一
 * 目录。检查/使用分歧:校验器看到 `../project/hooks`,PowerShell 对着
 * cwd 解析出 `hooks`。
 */
function resolveCwdReentry(normalized: string): string {
  if (!normalized.startsWith('../')) return normalized;
  const cwdBase = basename(process.cwd()).toLowerCase();
  if (!cwdBase) return normalized;
  // 迭代剥掉 `../<cwd-basename>/` 对(可处理 `../../p/p/hooks`;
  // cwd 有重复 basename 段的情况不太可能,单层是常见攻击)。
  const prefix = '../' + cwdBase + '/';
  let s = normalized;
  while (s.startsWith(prefix)) {
    s = s.slice(prefix.length);
  }
  // 同时处理恰为 `../<cwd-basename>`(无结尾斜杠)的情形
  if (s === '../' + cwdBase) return '.';
  return s;
}

/**
 * 把 PS 参数文本规范化为 git 内部匹配用的规范路径。
 * 顺序很重要:先做结构性剥离(冒号绑定参数、引号、反引号转义、provider
 * 前缀、盘符相对前缀),再做 NTFS 逐组件尾部剥离(空格总是剥;点只在
 * 剥完空格后不是 `.`/`..` 时剥),然后 posix.normalize(解析 `..`、`.`、
 * `//`),最后大小写折叠。
 */
function normalizeGitPathArg(arg: string): string {
  let s = arg;
  // 规范化参数前缀:破折号字符(–、—、―)与正斜杠(PS 5.1)。
  // /Path:hooks/pre-commit → 提取冒号绑定值。(bug #28)
  if (s.length > 0 && (PS_TOKENIZER_DASH_CHARS.has(s[0]!) || s[0] === '/')) {
    const c = s.indexOf(':', 1);
    if (c > 0) s = s.slice(c + 1);
  }
  s = s.replace(/^['"]|['"]$/g, '');
  s = s.replace(/`/g, '');
  // PS provider 限定路径:FileSystem::hooks/pre-commit → hooks/pre-commit
  // 同时处理完全限定形式:Microsoft.PowerShell.Core\FileSystem::path
  s = s.replace(/^(?:[A-Za-z0-9_.]+\\){0,3}FileSystem::/i, '');
  // 盘符相对的 C:foo(冒号后无分隔符)是该驱动器上的 cwd 相对路径。
  // C:\foo(带分隔符)是绝对路径,不得匹配——否定先行断言保留它。
  s = s.replace(/^[A-Za-z]:(?![/\\])/, '');
  s = s.replace(/\\/g, '/');
  // Win32 CreateFileW 逐组件处理:迭代剥尾部空格,再剥尾部点,若结果是
  // `.` 或 `..`(特殊)则停。`.. ` → `..`,`.. .` → `..`,`...` → '' →
  // `.`,`hooks .` → `hooks`。原本就是 '' 的(开头斜杠切出)保持 ''
  // (绝对路径标记)。
  s = s
    .split('/')
    .map(c => {
      if (c === '') return c;
      let prev;
      do {
        prev = c;
        c = c.replace(/ +$/, '');
        if (c === '.' || c === '..') return c;
        c = c.replace(/\.+$/, '');
      } while (c !== prev);
      return c || '.';
    })
    .join('/');
  s = posix.normalize(s);
  if (s.startsWith('./')) s = s.slice(2);
  return s.toLowerCase();
}

const GIT_INTERNAL_PREFIXES = ['head', 'objects', 'refs', 'hooks'] as const;

/**
 * 安全:把逃出 cwd 的规范化路径(开头 `../` 或绝对路径)对着真实 cwd
 * 解析,再检查它是否落回 cwd 内部。若是,剥掉 cwd 并返回 cwd 相对的
 * 剩余部分做前缀匹配。若落在 cwd 之外,返回 null(确属外部——那是
 * path-validation 的事)。覆盖 `..\<cwd-basename>\HEAD` 与
 * `C:\<full-cwd>\HEAD`——posix.normalize 单独处理不了它们(它把开头的
 * `..` 原样保留)。
 *
 * 这是裸仓库 HEAD 攻击的唯一防线。path-validation 的 DANGEROUS_FILES
 * 刻意排除裸 `HEAD`(对合法的同名非 git 文件有误报风险),而
 * DANGEROUS_DIRECTORIES 只按段匹配 `.git`——因此 `<cwd>/HEAD` 能过那
 * 一层。这里的 cwd 解析是承重墙;移除前必须先补上替代防护。
 */
function resolveEscapingPathToCwdRelative(n: string): string | null {
  const cwd = process.cwd();
  // 从 posix 规范化形式重建平台可解析路径。`n` 用正斜杠
  // (normalizeGitPathArg 已把 \\ 转成 /);resolve() 在 Windows 上能处理
  // 正斜杠。
  const abs = resolve(cwd, n);
  const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep;
  // 大小写不敏感比较:normalizeGitPathArg 已把 `n` 转小写,因此 resolve()
  // 输出中来自 `n` 的组件是小写,但 cwd 可能是混合大小写
  // (如 C:\Users\...)。Windows 路径大小写不敏感。
  const absLower = abs.toLowerCase();
  const cwdLower = cwd.toLowerCase();
  const cwdWithSepLower = cwdWithSep.toLowerCase();
  if (absLower === cwdLower) return '.';
  if (!absLower.startsWith(cwdWithSepLower)) return null;
  return abs.slice(cwdWithSep.length).replace(/\\/g, '/').toLowerCase();
}

function matchesGitInternalPrefix(n: string): boolean {
  if (n === 'head' || n === '.git') return true;
  if (n.startsWith('.git/') || /^git~\d+($|\/)/.test(n)) return true;
  for (const p of GIT_INTERNAL_PREFIXES) {
    if (p === 'head') continue;
    if (n === p || n.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * 参数(原始 PS 参数文本)解析为 cwd 内的 git 内部路径时返回 true。
 * 同时覆盖裸仓库路径(hooks/、refs/)与标准仓库路径(.git/hooks/、
 * .git/config)。
 */
export function isGitInternalPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg));
  if (matchesGitInternalPrefix(n)) return true;
  // 安全:resolveCwdReentry 与 posix.normalize 没能完全解析的开头 `../`
  // 或绝对路径。对着真实 cwd 解析——若结果落回 cwd 内的 git 内部位置,
  // 防护仍须触发。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n);
    if (rel !== null && matchesGitInternalPrefix(rel)) return true;
  }
  return false;
}

/**
 * 参数解析为 .git/ 内部路径(标准仓库元数据目录)时返回 true。
 * 与 isGitInternalPathPS 不同,不匹配裸仓库风格的根级 `hooks/`、`refs/`
 * 等——那些是常见的项目目录名。
 */
export function isDotGitPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg));
  if (matchesDotGitPrefix(n)) return true;
  // 安全:与 isGitInternalPathPS 同样的 cwd 解析——兜住落回 cwd 的
  // `..\<cwd-basename>\.git\hooks\pre-commit`。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n);
    if (rel !== null && matchesDotGitPrefix(rel)) return true;
  }
  return false;
}

function matchesDotGitPrefix(n: string): boolean {
  if (n === '.git' || n.startsWith('.git/')) return true;
  // NTFS 8.3 短名:.git 变成 GIT~1(多个点文件以 "git" 开头时是 GIT~2
  // 等)。normalizeGitPathArg 已转小写,因此检查首组件是否为 git~N。
  return /^git~\d+($|\/)/.test(n);
}
