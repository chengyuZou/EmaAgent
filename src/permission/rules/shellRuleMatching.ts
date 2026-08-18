// shell 命令与规则内容的匹配引擎：exact / `:*` 前缀 / wildcard 三形态。
// `:*` 前缀语法作为规则格式正式一员保留（非 legacy），suggestion 构造器移出（归卡片流程）。

const ESCAPED_STAR_PLACEHOLDER = '\x00ESCAPED_STAR\x00';
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00';
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, 'g');
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, 'g');

export type ShellPermissionRule =
  | { readonly type: 'exact'; readonly command: string }
  | { readonly type: 'prefix'; readonly prefix: string }
  | { readonly type: 'wildcard'; readonly pattern: string };

/** `npm:*` → `npm`；不是前缀形态返回 null。 */
export function permissionRuleExtractPrefix(permissionRule: string): string | null {
  const match = permissionRule.match(/^(.+):\*$/);
  return match?.[1] ?? null;
}

/** 模式是否含未转义通配符（末尾 `:*` 前缀形态不算 wildcard）。 */
export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(':*')) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) return true;
    }
  }
  return false;
}

/**
 * wildcard 匹配：`*` 匹配任意序列；`\*` 匹配字面星号；`\\` 匹配字面反斜杠。
 * 末尾 `' *'`（空格+唯一通配符）可选化，使 'git *' 同时匹配 'git add' 与裸 'git'，
 * 与前缀规则 `git:*` 语义对齐；dotAll 让通配覆盖内嵌换行（heredoc 等）。
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  const trimmedPattern = pattern.trim();
  let processed = '';
  let i = 0;

  while (i < trimmedPattern.length) {
    const char = trimmedPattern[i];
    if (char === '\\' && i + 1 < trimmedPattern.length) {
      const nextChar = trimmedPattern[i + 1];
      if (nextChar === '*') {
        processed += ESCAPED_STAR_PLACEHOLDER;
        i += 2;
        continue;
      } else if (nextChar === '\\') {
        processed += ESCAPED_BACKSLASH_PLACEHOLDER;
        i += 2;
        continue;
      }
    }
    processed += char;
    i++;
  }

  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*');

  let regexPattern = withWildcards
    .replace(ESCAPED_STAR_PLACEHOLDER_RE, '\\*')
    .replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, '\\\\');

  const unescapedStarCount = (processed.match(/\*/g) || []).length;
  if (regexPattern.endsWith(' .*') && unescapedStarCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + '( .*)?';
  }

  const flags = 's' + (caseInsensitive ? 'i' : '');
  return new RegExp(`^${regexPattern}$`, flags).test(command);
}

/** 规则文本 → 三形态判别。 */
export function parsePermissionRule(permissionRule: string): ShellPermissionRule {
  const prefix = permissionRuleExtractPrefix(permissionRule);
  if (prefix !== null) {
    return { type: 'prefix', prefix };
  }
  if (hasWildcards(permissionRule)) {
    return { type: 'wildcard', pattern: permissionRule };
  }
  return { type: 'exact', command: permissionRule };
}

/** 命令是否命中规则内容（shell 家族 checkPermissions 的单条判定）。 */
export function matchShellRule(ruleContent: string, command: string): boolean {
  const rule = parsePermissionRule(ruleContent);
  switch (rule.type) {
    case 'exact':
      return command.trim() === rule.command.trim();
    case 'prefix':
      return command.trim() === rule.prefix
        || command.trimStart().startsWith(rule.prefix + ' ');
    case 'wildcard':
      return matchWildcardPattern(rule.pattern, command);
  }
}
