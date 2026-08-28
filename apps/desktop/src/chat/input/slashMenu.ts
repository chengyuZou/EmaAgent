// 斜杠菜单的触发判定与条目过滤（纯函数，可单测）。
// 触发规则：未闭合的斜杠 token 只能位于整段文字开头或末尾。

export interface SlashToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export function activeSlashToken(text: string, caret = text.length): SlashToken | null {
  if (caret < 0 || caret > text.length) return null;
  const beforeCaret = text.slice(0, caret);
  const slash = beforeCaret.lastIndexOf('/');
  if (slash < 0) return null;
  const token = beforeCaret.slice(slash + 1);
  if (/\s/.test(token)) return null;
  const atStart = slash === 0;
  const atEnd = caret === text.length && (slash === 0 || /\s/.test(text[slash - 1] ?? ''));
  if (!atStart && !atEnd) return null;
  return { start: slash, end: caret, query: token };
}

/** 当前文本是否处于"斜杠命令输入中"；是则返回已键入的过滤词（不含 '/'），否则 null。 */
export function slashQuery(text: string): string | null {
  return activeSlashToken(text)?.query ?? null;
}

/** 大小写不敏感的前缀过滤（命令名/技能名），空过滤词放行全部。 */
export function matchesSlashQuery(name: string, query: string): boolean {
  if (query === '') return true;
  return name.toLowerCase().includes(query.toLowerCase());
}
