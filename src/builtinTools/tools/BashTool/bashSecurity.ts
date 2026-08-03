// Bash 命令静态安全分析: 危险路径硬拦、重定向越界、命令替换、复合攻击、
// sed 后门、只读证明与破坏性警告的单一事实源。分析在归一化副本上进行
// (防 Unicode 空白绕过正则), 命令本身原样执行不改写。
//
// 判定分三档:
//   deny —— 硬拦截, 对应 BashTool.validateInput, 任何权限模式都不放行;
//   ask  —— 无法静态证明安全, 依赖 Bash 高风险默认确认流程;
//           注意: 用户已保存的 allow 规则可豁免此档(已知边界);
//   ok   —— 进入正常权限流; readOnly=true 时工具另声明只读。

// ── 判定结果 ──────────────────────────────────────────────────────────────────

export interface BashSafetyVerdict {
  kind: 'deny' | 'ask' | 'ok';
  /** deny/ask 时给人看的原因。 */
  reason?: string;
  /** 破坏性命令警告(纯展示, 不影响判定, 拼进结果 note)。 */
  warnings: string[];
  /** 结构化证明整条命令只读: 无重定向写入, 每段都在只读白名单内。 */
  readOnly: boolean;
}

// ── Shell 词法扫描(引号/转义感知, 长度保持不变) ────────────────────────────────

/**
 * 把引号内容和转义字符替换为空格, 保留结构与操作符, 长度与原串一致。
 * 掩码用于定位操作符; 索引与原串对齐, 目标文本从原串同位读取。
 * 单引号内无转义; 双引号内 \" \$ \` \\ 是转义; 引号外 \ 转义下一字符。
 */
function maskQuotedAndEscaped(input: string): string {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === null) {
      if (ch === "'" || ch === '"') { quote = ch; out += ' '; continue; }
      if (ch === '\\') { out += ' '; i++; if (i < input.length) out += ' '; continue; }
      out += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += ' ';
      continue;
    }
    if (ch === '\\' && i + 1 < input.length && '"$`\\'.includes(input[i + 1]!)) {
      out += '  ';
      i++;
      continue;
    }
    if (ch === '"') quote = null;
    out += ' ';
  }
  return out;
}

/** 按 && || ; | 切分复合命令(引号/转义感知), 返回每段原始文本。 */
export function splitCommandSegments(command: string): string[] {
  const masked = maskQuotedAndEscaped(command);
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '|' || ch === '&' || ch === ';') {
      spans.push([start, i]);
      if ((ch === '|' || ch === '&') && masked[i + 1] === ch) i++;
      start = i + 1;
    }
  }
  spans.push([start, masked.length]);
  return spans
    .map(([a, b]) => command.slice(a, b).trim())
    .filter((s) => s.length > 0);
}

// ── Unicode 空白归一化(仅用于分析副本) ─────────────────────────────────────────

const UNICODE_WHITESPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

/** 把各种 Unicode 空白折叠为 ASCII 空格; 只在分析副本上使用, 不改写原命令。 */
function normalizeWhitespace(input: string): string {
  return input.replace(UNICODE_WHITESPACE, ' ');
}

// ── 前置字符检查 ──────────────────────────────────────────────────────────────

/** 控制字符(除 \n \t)与回车: 经典注入/终端逃逸向量, 合法命令几乎不含。 */
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/;

// ── 命令替换闸门 ──────────────────────────────────────────────────────────────

/**
 * 单引号内没有 Shell 展开；双引号内的 `$()`、`${}` 和反引号仍会执行。
 * 逐字符扫描可以区分真正的转义，避免把 `"\$(date)"` 当成活动替换。
 */
function containsActiveShellSubstitution(input: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '\\' && quote !== "'") {
      index += 1;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === "'") continue;
    if (character === '`') return true;
    if (character === '$' && (input[index + 1] === '(' || input[index + 1] === '{')) {
      return true;
    }
    if (
      quote === null
      && (character === '<' || character === '>')
      && input[index + 1] === '('
    ) {
      return true;
    }
  }
  return false;
}

// ── 硬拦模式 ──────────────────────────────────────────────────────────────────

/** 不可逆系统损害: 任何模式下都拒绝。匹配在空白归一化副本上进行。 */
const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /:\(\)\{\s*:\|:\s*&\s*\};:/, reason: 'fork 炸弹' },
  { pattern: /\bmkfs\b/i, reason: 'mkfs 格式化文件系统' },
  { pattern: /\bformat\s+(c:|\/dev\/)/i, reason: 'format 格式化磁盘' },
  { pattern: /\bdd\b[^|&;]*\bof=\/dev\/(s|h)d/i, reason: 'dd 直接写磁盘设备' },
  { pattern: /\b(shred|wipefs)\b/i, reason: '安全擦除磁盘数据' },
];

/** rm 的危险目标：根、家目录、系统关键目录、盘符根与 `..` 上溢。 */
const DANGEROUS_RM_TARGET =
  /^(\/$|\/\*|~(?:\/|$)|\/(?:Applications|Library|System|Users|bin|boot|dev|etc|home|lib|lib64|proc|root|sbin|sys|usr|var)(?:\/|$)|\/[A-Za-z]\/(?:Windows|Program Files|ProgramData|Users)(?:\/|$)|[A-Za-z]:[\\/]?\*?$|\.\.(?:\/|$))/i;

/**
 * rm/rmdir 递归强制删除: 目标是危险位置才硬拦,
 * 工作区内 rm -rf(如清理 node_modules)交给正常权限流。
 */
function dangerousRmReason(segment: string): string | undefined {
  const unquoted = segment.replace(/'([^']*)'|"([^"]*)"/g, (_match, single, double) => (
    single ?? double ?? ''
  ));
  const m = /^(?:rm|rmdir)\s+(.*)$/.exec(unquoted);
  if (!m) return undefined;
  const rest = m[1]!;
  if (!/(^|\s)-[a-zA-Z]*[rRf][a-zA-Z]*(\s|$)|--recursive|--force/.test(rest)) return undefined;
  for (const token of rest.split(/\s+/).filter((t) => !t.startsWith('-'))) {
    if (DANGEROUS_RM_TARGET.test(token)) return `rm 递归强制删除危险路径 ${token}`;
  }
  return undefined;
}

// ── wrapper 剥离(在掩码副本上分析) ────────────────────────────────────────────

const ENV_ASSIGN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=\S+/;
const STRIPPABLE_WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'env']);

/**
 * 剥掉命令头部无效应答: `FOO=bar`、`timeout 10`、`nice` 等, 返回基命令文本。
 * 防止 `FOO=bar rm -rf /` 绕过路径与黑名单检查。输入应为掩码副本,
 * 含空格引号值的 env 赋值不会被误剥(保守方向)。
 */
export function stripWrappers(maskedSegment: string): string {
  let rest = maskedSegment.trim();
  for (let guard = 0; guard < 10; guard++) {
    const env = ENV_ASSIGN_PATTERN.exec(rest);
    if (env) { rest = rest.slice(env[0].length).trimStart(); continue; }
    const word = /^(\S+)(?:\s+|$)/.exec(rest);
    if (word && STRIPPABLE_WRAPPERS.has(word[1]!)) {
      rest = rest.slice(word[0].length).trimStart();
      if (word[1] === 'timeout' || word[1] === 'stdbuf') {
        rest = rest.replace(/^\S+\s+/, '');
      }
      continue;
    }
    break;
  }
  return rest;
}

/** 命令词去路径: `/usr/bin/git` → `git`。 */
function baseCommand(segment: string): string {
  const word = /^(\S+)/.exec(segment)?.[1] ?? '';
  return word.replace(/^.*\//, '');
}

// ── 重定向目标校验 ────────────────────────────────────────────────────────────

/**
 * 提取输出重定向目标(> >> N> N>>), 跳过 fd 复制(>&2 2>&1)与输入重定向。
 * 掩码定位 `>` 位置, 目标从原串同位读取(支持带空格/引号的目标)。
 */
function extractRedirectTargets(segment: string): string[] {
  const masked = maskQuotedAndEscaped(segment);
  const targets: string[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '>') continue;
    if (masked[i + 1] === '&') continue;                       // fd 复制 >&2
    const prev = i > 0 ? masked[i - 1]! : ' ';
    if (prev === '>') continue;                                // >> 的第二个已在首枚处理
    if (prev === '&' || /\d/.test(prev) && masked[i - 2] === '&') continue;
    // 从原串同位读目标: 跳过 > 与空白, 支持引号目标
    let j = i;
    while (j < segment.length && segment[j] === '>') j++;
    while (j < segment.length && /\s/.test(segment[j]!)) j++;
    if (j >= segment.length) continue;
    let target: string;
    if (segment[j] === "'" || segment[j] === '"') {
      const q = segment[j]!;
      const end = segment.indexOf(q, j + 1);
      target = end === -1 ? segment.slice(j + 1) : segment.slice(j + 1, end);
    } else {
      const rest = segment.slice(j);
      target = /^\S+/.exec(rest)?.[0] ?? '';
    }
    if (target) targets.push(target);
  }
  return targets;
}

/** 绝对路径判定: Unix /x、Windows C:\x 或 C:/x、家目录 ~/x。 */
function isAbsoluteTarget(target: string): boolean {
  return target.startsWith('/') || target.startsWith('~') || /^[A-Za-z]:[\\/]/.test(target);
}

function pathInside(root: string, target: string): boolean {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = target.replace(/\\/g, '/');
  return t === r || t.startsWith(r + '/');
}

/**
 * 重定向目标允许: /dev/null、系统临时目录内、工作区相对路径;
 * 含 .. 段一律拒绝(逃出 cwd); 其余绝对路径拒绝。
 * 执行时 cwd 即工作区, 因此本判定无需 workspaceRoot 也能与执行语义一致。
 */
function redirectAllowed(target: string, tmpDir: string): boolean {
  if (target === '/dev/null') return true;
  if (target.includes('$')) return false; // 含变量: 由上层按 ask 处理
  const segments = target.split(/[\\/]+/);
  if (segments.includes('..')) return false;
  if (!isAbsoluteTarget(target)) return true;
  return pathInside(tmpDir, target);
}

// ── sed 校验 ──────────────────────────────────────────────────────────────────

/** 取出 sed 脚本(单/双引号内容); 无引号时返回首个非 flag 参数。 */
function sedScripts(segment: string): string[] {
  const scripts: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) scripts.push(m[1] ?? m[2] ?? '');
  if (scripts.length > 0) return scripts;
  const bare = /^sed\s+(?:-\S+\s+)*(\S+)/.exec(segment);
  return bare ? [bare[1]!] : [];
}

/**
 * sed 是"程序内嵌一门语言": w/W 写任意文件、e/E 执行任意命令。
 * 脚本含 w/W/e/E 命令字母(行首/;/{} 边界)或 s 命令带 w/e flags 即拒绝。
 * 基命令判定在掩码剥离副本上, 脚本提取必须读原始段(引号内容不能被抹)。
 */
function sedSegmentVerdict(segment: string): 'ok' | 'deny' | 'unknown' {
  if (baseCommand(stripWrappers(maskQuotedAndEscaped(segment))) !== 'sed') return 'unknown';
  for (const script of sedScripts(segment)) {
    if (/(^|[;{}\n])\s*[0-9$,~!\/().^+-]*[wWeE](\s|$|\/)/.test(script)) return 'deny';
    if (/s(.).*\1.*\1[gpimIM0-9]*[wWeE]/.test(script)) return 'deny';
  }
  return 'ok';
}

// ── 复合攻击 ──────────────────────────────────────────────────────────────────

const GIT_INTERNAL_PATH = /\.git\/(HEAD|objects|refs|hooks|config)(\/|$)/;
const GIT_INTERNAL_WRITE = /\b(rm|mv|cp|tee|chmod|ln|vi|nano)\b[^|&;]*\.git\//;

// ── 只读证明 ──────────────────────────────────────────────────────────────────

/** 只读命令白名单: 无写副作用、无网络、无进程派生。 */
const READONLY_SIMPLE = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'echo', 'printf',
  'true', 'false', ':', 'which', 'whereis', 'type', 'uname', 'date', 'df', 'du',
  'hostname', 'whoami', 'id', 'printenv', 'basename', 'dirname', 'realpath',
  'readlink', 'tree', 'less', 'more',
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse',
  'ls-files', 'describe', 'blame', 'shortlog',
]);

/** find 的写入/执行 flag: 出现即不算只读。 */
const FIND_WRITE_FLAGS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprintf',
]);

function segmentReadOnly(segment: string): boolean {
  const stripped = stripWrappers(
    segment.replace(/'([^']*)'|"([^"]*)"/g, (_match, single, double) => (
      single ?? double ?? ''
    )),
  );
  const base = baseCommand(stripped);
  if (!base) return false;
  if (READONLY_SIMPLE.has(base)) return true;
  if (base === 'grep' || base === 'rg' || base === 'egrep' || base === 'fgrep') return true;
  if (base === 'find') {
    return !stripped.split(/\s+/).some((t) => FIND_WRITE_FLAGS.has(t));
  }
  if (base === 'git') {
    const args = stripped.split(/\s+/).slice(1);
    const subcommand = args[0];
    if (subcommand !== undefined && READONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
    if (subcommand === 'branch') {
      return args.length === 1 || args.slice(1).every(argument => /^-(a|r|v|vv|l|-list|-show-current)$/.test(argument));
    }
    if (subcommand === 'tag') {
      return args.length === 1 || args.slice(1).every(argument => argument === '-l' || argument === '--list');
    }
    if (subcommand === 'remote') {
      return args.length === 1
        || (args.length === 2 && args[1] === '-v')
        || args[1] === 'get-url';
    }
    return false;
  }
  if (base === 'sed') {
    return /^sed\s+-n\s+('[0-9,;$p ]+'|[0-9,;$p ]+)\s*\S*$/.test(stripped);
  }
  return false;
}

// ── 破坏性命令警告(纯展示) ─────────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: 'git reset --hard 可能丢弃未提交修改' },
  { pattern: /\bgit\s+push\b[^|&;]*(-f\b|--force\b)/, warning: 'git push --force 可能覆盖远端历史' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, warning: 'git clean -f 可能删除未跟踪文件' },
  { pattern: /\bgit\s+checkout\s+\.\s*$/, warning: 'git checkout . 可能丢弃工作区修改' },
  { pattern: /\bgit\s+stash\s+drop\b/, warning: 'git stash drop 可能丢失暂存内容' },
  { pattern: /\bgit\s+branch\s+-D\b/, warning: 'git branch -D 强制删除分支' },
  { pattern: /--no-verify\b/, warning: '--no-verify 跳过 Git 安全钩子' },
  { pattern: /\bgit\s+commit\b[^|&;]*--amend\b/, warning: 'git commit --amend 改写上一次提交' },
  { pattern: /\brm\s+(-[a-zA-Z]*[rRf]|--recursive|--force)/, warning: 'rm 递归/强制删除文件' },
  { pattern: /\b(DROP|TRUNCATE)\s+TABLE\b/i, warning: 'SQL 删除/清空表' },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*(?:;|$)/i, warning: 'DELETE 无 WHERE 可能删除全部行' },
  { pattern: /\bkubectl\s+delete\b/, warning: 'kubectl delete 删除 Kubernetes 资源' },
  { pattern: /\bterraform\s+destroy\b/, warning: 'terraform destroy 销毁基础设施' },
];

/** 整条命令的破坏性警告(取第一条命中, 避免噪音)。 */
export function destructiveWarningFor(command: string): string | undefined {
  const normalized = normalizeWhitespace(command);
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) return warning;
  }
  return undefined;
}

// ── 主分析入口 ────────────────────────────────────────────────────────────────

const MAX_SEGMENTS = 50;

export function analyzeBashCommand(
  command: string,
  opts: { tmpDir?: string } = {},
): BashSafetyVerdict {
  const tmpDir = opts.tmpDir ?? '/tmp';
  const warnings = (): string[] => {
    const w = destructiveWarningFor(command);
    return w ? [w] : [];
  };
  const fail = (kind: 'deny' | 'ask', reason: string): BashSafetyVerdict => ({
    kind, reason, warnings: warnings(), readOnly: false,
  });

  // 1. 前置字符: 控制字符/回车硬拦(注入与终端逃逸向量)。
  if (CONTROL_CHAR_PATTERN.test(command)) {
    return fail('deny', '命令包含控制字符或回车, 可能用于注入或终端逃逸');
  }

  // 2. 命令替换闸门: $() ` ` ${} <() >() 出现在引号外 → 无法静态证明安全。
  if (containsActiveShellSubstitution(command)) {
    return fail('ask', '命令包含命令替换/进程替换, 无法静态证明其安全性');
  }

  // 3. 分段与复杂度上限(分析在空白归一化副本上进行)。
  const normalizedCommand = normalizeWhitespace(command);
  const segments = splitCommandSegments(normalizedCommand);
  if (segments.length > MAX_SEGMENTS) {
    return fail('ask', `复合命令超过 ${MAX_SEGMENTS} 段, 放弃逐段分析`);
  }

  // 4. 硬拦模式: 对整条命令的掩码副本匹配——fork 炸弹等模式本身含 | & ;,
  //    会被分段切开, 不能按段判定; 掩码抹掉引号内容防止文字讨论误伤。
  const maskedCommand = maskQuotedAndEscaped(normalizedCommand);
  for (const { pattern, reason } of BANNED_PATTERNS) {
    if (pattern.test(maskedCommand)) return fail('deny', `命中禁止模式: ${reason}`);
  }

  let sawCd = false;
  let sawGit = false;
  let sawRedirect = false;
  let sawGitInternalWrite = false;

  for (const segment of segments) {
    const masked = maskQuotedAndEscaped(segment);
    const stripped = stripWrappers(masked);

    // 5. rm 危险目标(剥离 wrapper 后判定基命令)。
    const rmReason = dangerousRmReason(stripWrappers(segment));
    if (rmReason) return fail('deny', rmReason);

    // 6. 重定向目标。
    for (const target of extractRedirectTargets(segment)) {
      if (target.includes('$')) {
        return fail('ask', `重定向目标 ${target} 含变量, 无法静态解析`);
      }
      sawRedirect = true;
      if (!redirectAllowed(target, tmpDir)) {
        return fail('deny', `重定向目标 ${target} 越出工作区与临时目录`);
      }
      if (GIT_INTERNAL_PATH.test(target)) sawGitInternalWrite = true;
    }

    // 7. sed 后门(脚本必须从原始段提取)。
    if (sedSegmentVerdict(segment) === 'deny') {
      return fail('deny', 'sed 的 w/W/e/E 命令可写文件或执行命令, 禁止经 Bash 使用');
    }

    // 8. 复合攻击素材收集(基命令去路径后判定)。
    const base = baseCommand(stripped);
    if (base === 'cd') sawCd = true;
    if (base === 'git') sawGit = true;
    if (GIT_INTERNAL_WRITE.test(segment)) sawGitInternalWrite = true;
  }

  // 9. 复合攻击判定。
  if (sawCd && sawGit) {
    return fail('ask', 'cd 与 git 组合命令无法排除仓库上下文攻击, 需要确认');
  }
  if (sawCd && sawRedirect) {
    return fail('ask', 'cd 与重定向组合命令的落盘位置无法静态证明, 需要确认');
  }
  if (sawGitInternalWrite && sawGit) {
    return fail('ask', '命令同时写 Git 内部文件并运行 git, 需要确认');
  }

  // 10. 只读证明: 全部段落只读且无重定向写入。
  const readOnly =
    !sawRedirect && segments.every(segmentReadOnly);
  return { kind: 'ok', warnings: warnings(), readOnly };
}
