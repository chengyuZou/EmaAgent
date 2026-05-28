import type { TtsTurnMode } from '@ema-agent/contracts';

// ── 状态说明 ───────────────────────────────────────────────────────────────────
//
//  normal       正常文本，行首监控 fence / $$ 开头
//  in_opener    已确认 opener，吃掉 language tag 行直到 \n，同时收集语言标识
//  fenced_code  \`\`\` / ~~~ 块内，丢弃内容，行首监控 closer
//  math_block   $$ 块内，丢弃内容，行首监控 $$
//  in_closer    已确认 closer，吃掉 closer 行剩余直到 \n，然后回 normal
//
//  fenceChar = '\`' | '~'  → fenced_code 路径
//  fenceChar = '$'        → math_block  路径（复用相同的 opener/closer 逻辑）
//
// 关闭启发式规则：
//   代码块 — 行首 3+ 个与 opener 同类字符即可关闭，不要求数量完全匹配，
//             不同类字符（\` 对 ~）不能关闭对方
//   数学块 — 行首 $$ 关闭
//   LLM 完全没写关闭符 → flush() 兜底
//
// 性能：
//   normal 状态             逐字符（大部分文本走这里，开销最小）
//   fenced/math 状态        indexOf('\\n') 跳行 — O(行数) 而非 O(字符数)
//   in_opener/in_closer     indexOf('\\n') 直接跳到换行
//
// lineStartBuf 最多缓存 2 个字符（第 3 个到达时就能判定了）

type FilterState =
  | 'normal'
  | 'in_opener'
  | 'fenced_code'
  | 'math_block'
  | 'in_closer';

export class TextFilterStream {
  private state: FilterState = 'normal';
  private fenceChar = '';    // '\`' | '~' | '$'
  private atLineStart = true;
  private lineStartBuf = ''; // ≤ 2 字符，跨 chunk 保留
  private langTag = '';      // opener 行收集的语言标识（如 "python"），跨 chunk 保留

  constructor(private readonly turnMode: TtsTurnMode) {}

  /**
   * 喂入 LLM delta chunk，返回清洗后的文本。
   *
   * 代码块 / 数学块内容被丢弃，在关闭时 emit 一个替换词。
   * 替换词包含语言标识（如有）：`(python代码)` / `(代码)` / `(数学公式)`。
   * 普通文本零延迟直通（最多 2 字符行首 lookahead）。
   */
  feed(chunk: string): string {
    let out = '';
    let pos = 0;
    const len = chunk.length;

    while (pos < len) {
      switch (this.state) {

        // ── in_opener：快速跳行，同时收集语言标识 ─────────────────────────
        case 'in_opener': {
          const nl = chunk.indexOf('\n', pos);
          if (nl === -1) {
            this.langTag += chunk.slice(pos);
            return out;
          }
          this.langTag += chunk.slice(pos, nl);
          pos = nl;
          out += this.step(chunk[pos]!);
          pos++;
          continue;
        }

        // ── in_closer：快速跳行，无需收集内容 ────────────────────────────
        case 'in_closer': {
          const nl = chunk.indexOf('\n', pos);
          if (nl === -1) return out;
          pos = nl;
          out += this.step(chunk[pos]!);
          pos++;
          continue;
        }

        // ── fenced_code / math_block：非行首时快速跳行 ────────────────────
        case 'fenced_code':
        case 'math_block': {
          if (!this.atLineStart) {
            const nl = chunk.indexOf('\n', pos);
            if (nl === -1) return out;
            pos = nl;
            out += this.step(chunk[pos]!);
            pos++;
            continue;
          }
          break;
        }

        default:
          break;
      }

      out += this.step(chunk[pos]!);
      pos++;
    }

    return out;
  }

  /**
   * 流结束时调用。
   * - 未闭合的代码块/数学块 → emit 替换词
   * - 残留的行首 lookahead 字符 → 作为普通文本 emit
   */
  flush(): string {
    const remnant = this.lineStartBuf;
    this.lineStartBuf = '';
    this.atLineStart  = true;

    if (
      this.state === 'fenced_code' ||
      this.state === 'math_block'  ||
      this.state === 'in_opener'
    ) {
      this.state = 'normal';
      return this.codeReplacement();
    }

    this.state   = 'normal';
    this.langTag = '';
    return remnant;
  }

  private step(ch: string): string {
    switch (this.state) {
      case 'normal':      return this.onNormal(ch);
      case 'in_opener':   return this.onInOpener(ch);
      case 'fenced_code': return this.onFenced(ch);
      case 'math_block':  return this.onMath(ch);
      case 'in_closer':   return this.onInCloser(ch);
    }
  }

  private onNormal(ch: string): string {
    if (this.atLineStart) {
      const extending = this.lineStartBuf === '' || this.lineStartBuf[0] === ch;

      if ((ch === '\`' || ch === '~') && extending) {
        this.lineStartBuf += ch;
        if (this.lineStartBuf.length >= 3) {
          this.fenceChar    = ch;
          this.lineStartBuf = '';
          this.langTag      = '';
          this.atLineStart  = false;
          this.state        = 'in_opener';
        }
        return '';
      }

      if (ch === '$' && extending) {
        this.lineStartBuf += ch;
        if (this.lineStartBuf.length >= 2) {
          this.fenceChar    = '$';
          this.lineStartBuf = '';
          this.langTag      = '';
          this.atLineStart  = false;
          this.state        = 'in_opener';
        }
        return '';
      }

      const pending     = this.lineStartBuf;
      this.lineStartBuf = '';
      this.atLineStart  = ch === '\n';
      return pending + ch;
    }

    if (ch === '\n') {
      this.atLineStart = true;
      return '\n';
    }
    return ch;
  }

  // feed() 快速路径已把语言标识字符追加到 langTag；这里只处理 \n。
  private onInOpener(ch: string): string {
    if (ch === '\n') {
      this.atLineStart = true;
      this.state       = this.fenceChar === '$' ? 'math_block' : 'fenced_code';
    }
    return '';
  }

  private onFenced(ch: string): string {
    if (this.atLineStart) {
      if (ch === this.fenceChar) {
        this.lineStartBuf += ch;
        if (this.lineStartBuf.length >= 3) {
          this.lineStartBuf = '';
          this.atLineStart  = false;
          this.state        = 'in_closer';
          return this.codeReplacement();
        }
        return '';
      }
      this.lineStartBuf = '';
      this.atLineStart  = ch === '\n';
      return '';
    }
    if (ch === '\n') this.atLineStart = true;
    return '';
  }

  // closer 是行首 $$（2个）而非 3+。
  private onMath(ch: string): string {
    if (this.atLineStart) {
      if (ch === '$') {
        this.lineStartBuf += ch;
        if (this.lineStartBuf.length >= 2) {
          this.lineStartBuf = '';
          this.atLineStart  = false;
          this.state        = 'in_closer';
          return ' (数学公式) ';
        }
        return '';
      }
      this.lineStartBuf = '';
      this.atLineStart  = ch === '\n';
      return '';
    }
    if (ch === '\n') this.atLineStart = true;
    return '';
  }

  private onInCloser(ch: string): string {
    if (ch === '\n') {
      this.atLineStart = true;
      this.state       = 'normal';
    }
    return '';
  }

  // 有语言标识时：(python代码) / (python代码已省略)
  // 无语言标识时：(代码)       / (代码已省略)
  private codeReplacement(): string {
    const lang = this.langTag.trim();
    this.langTag = '';

    if (lang) {
      return this.turnMode === 'agent'
        ? ` (${lang}代码已省略) `
        : ` (${lang}代码) `;
    }
    return this.turnMode === 'agent' ? ' (代码已省略) ' : ' (代码) ';
  }
}

// ── filterSentenceForTts ──────────────────────────────────────────────────────
//
// 无状态过滤，作用于 SentenceSplitter 已切出的完整句子。
// 此时块级结构已由 TextFilterStream 处理完毕，只需清理行内 markdown 与 URL/路径。
// 处理顺序很重要——详见 docs/streaming-pipeline.md §filterSentenceForTts。

const RE_ACT_MARKER    = /<\|(?:ACT|DELAY)[^|]*\|>/g;
const RE_HTML_TAG      = /<\/?[a-zA-Z][^>]*>/g;
const RE_MD_IMAGE      = /!\[[^\]]*\]\([^)]+\)/g;
const RE_MD_LINK       = /\[([^\]]*)\]\([^)]+\)/g;

const RE_HEADING       = /^#{1,6}\s+/gm;
const RE_BLOCKQUOTE    = /^>\s*/gm;
const RE_HR            = /^[-*_]{3,}\s*$/gm;
const RE_TABLE_SEP     = /^[|:\- ]+\|[|:\- ]*$/gm;
const RE_TABLE_PIPE    = /\|/g;
const RE_LIST_BULLET   = /^[-*+]\s+/gm;
const RE_LIST_ORDERED  = /^\d+\.\s+/gm;

const RE_BOLD_STAR     = /\*\*([^*\n]+)\*\*/g;
const RE_BOLD_UNDER    = /__([^_\n]+)__/g;
const RE_ITALIC_STAR   = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g;
const RE_ITALIC_UNDER  = /(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
const RE_STRIKETHROUGH = /~~([^~\n]+)~~/g;
const RE_INLINE_CODE   = /(\`{1,2})([^\`\n]+)\1/g;
const RE_MATH_INLINE   = /\$(?!\d)([^$\n]+)\$/g;
const RE_MATH_LATEX_I  = /\\\([^)]*\\\)/g;

const RE_URL           = /https?:\/\/[^\s)>\]]+/g;
const RE_WIN_PATH      = /[A-Za-z]:\\[^\s,;)]+/g;
const RE_NIX_PATH      = /(?<=^|\s)\/[a-zA-Z0-9_.\/-]{8,}(?=\s|$)/g;

export interface TtsFilterOptions {
  turnMode?: TtsTurnMode;
}

export function filterSentenceForTts(text: string, opts: TtsFilterOptions): string {
  let out = text;

  out = out.replace(RE_ACT_MARKER,    '');
  out = out.replace(RE_MD_IMAGE,      '(图片)');
  out = out.replace(RE_MD_LINK,       '$1');
  out = out.replace(RE_HTML_TAG,      '');
  out = out.replace(RE_HEADING,       '');
  out = out.replace(RE_BLOCKQUOTE,    '');
  out = out.replace(RE_HR,            '');
  out = out.replace(RE_TABLE_SEP,     '');
  out = out.replace(RE_TABLE_PIPE,    ' ');
  out = out.replace(RE_LIST_BULLET,   '');
  out = out.replace(RE_LIST_ORDERED,  '');
  out = out.replace(RE_BOLD_STAR,     '$1');
  out = out.replace(RE_BOLD_UNDER,    '$1');
  out = out.replace(RE_ITALIC_STAR,   '$1');
  out = out.replace(RE_ITALIC_UNDER,  '$1');
  out = out.replace(RE_STRIKETHROUGH, '$1');

  if (opts.turnMode === 'agent') {
    out = out.replace(RE_INLINE_CODE, '');
  }
  else {
    out = out.replace(RE_INLINE_CODE, '$2');
  }

  out = out.replace(RE_MATH_INLINE,   '(公式)');
  out = out.replace(RE_MATH_LATEX_I,  '(公式)');
  out = out.replace(RE_URL,           '链接');
  out = out.replace(RE_WIN_PATH,      '路径');
  out = out.replace(RE_NIX_PATH,      '路径');
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return out;
}

/** @deprecated 改名为 filterSentenceForTts，V1.1 删除 */
export const filterTextForTts = filterSentenceForTts;
