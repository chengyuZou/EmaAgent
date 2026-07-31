// JSON 文本的轻量高亮分词器,供 Tool 结果 raw 视图上色。
export const JSON_COLORS: Record<string, string> = {
  key:         'text-[var(--ema-syntax-key)]',
  string:      'text-[var(--ema-syntax-string)]',
  number:      'text-[var(--ema-syntax-number)]',
  boolean:     'text-[var(--ema-syntax-boolean)]',
  null:        'text-[var(--ema-syntax-comment)]',
  punctuation: 'text-[var(--ema-syntax-comment)]',
  plain:       'text-[var(--ema-text-secondary)]',
};

export type JsonToken = { type: string; text: string };

export function tokenizeJson(code: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  const n = code.length;
  const ch = (): string => code.charAt(i);

  while (i < n) {
    if (/[\s\[\]{}:,]/.test(ch())) {
      const start = i;
      while (i < n && /[\s\[\]{}:,]/.test(ch())) i++;
      tokens.push({ type: 'punctuation', text: code.slice(start, i) });
      continue;
    }

    if (ch() === '"') {
      const start = i++;
      while (i < n) {
        if (ch() === '\\') { i += 2; continue; }
        if (ch() === '"') { i++; break; }
        i++;
      }
      const raw = code.slice(start, i);
      let j = i;
      while (j < n && code.charAt(j) === ' ') j++;
      const isKey = code.charAt(j) === ':';
      tokens.push({ type: isKey ? 'key' : 'string', text: raw });
      continue;
    }

    if (/[-\d]/.test(ch())) {
      const start = i;
      while (i < n && /[\d.eE+\-]/.test(ch())) i++;
      tokens.push({ type: 'number', text: code.slice(start, i) });
      continue;
    }

    let matched = false;
    for (const kw of ['true', 'false', 'null']) {
      if (code.startsWith(kw, i)) {
        tokens.push({ type: kw === 'null' ? 'null' : 'boolean', text: kw });
        i += kw.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ type: 'plain', text: ch() });
      i++;
    }
  }
  return tokens;
}