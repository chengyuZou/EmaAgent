// 喂给 TTS 前的文本清洗：剥掉代码块和数学公式块，再剥行内 markdown/网址/路径，避免念出来乱。

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

  constructor() {}

  /**
   * 喂入 engine 已清洗后的可见 text delta，返回 TTS 可继续分句的文本。
   *
   * 代码块 / 数学块内容被丢弃，在关闭时 emit 一个替换词。
   * 替换词包含语言标识（如有）：`(python代码)` / `(代码)` / `(数学公式)`。
   *
   * 性能：normal 状态非行首时批量扫描到下一个 \n，避免逐字符 step() 调用。
   * 对于典型的对话文本（每行 20-60 字符），此优化将函数调用次数减少约 95%。
   */
  feed(chunk: string): string {
    let out = '';
    let pos = 0;
    const len = chunk.length;

    while (pos < len) {
      switch (this.state) {

        // ── normal 非行首：批量扫描到换行符 ──────────────────────────────
        case 'normal': {
          if (!this.atLineStart) {
            const nl = chunk.indexOf('\n', pos);
            if (nl === -1) {
              // 整个 chunk 剩余都是行内普通文本，直接拼接
              out += chunk.slice(pos);
              return out;
            }
            // 批量复制到换行符之前，然后逐字符处理 \n
            out += chunk.slice(pos, nl);
            pos = nl;
            out += this.step(chunk[pos]!);
            pos++;
            continue;
          }
          break;
        }

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

  private codeReplacement(): string {
    const lang = this.langTag.trim();
    this.langTag = '';
    return lang ? ` (${lang}代码) ` : ' (代码) ';
  }
}

// ── filterSentenceForTts ──────────────────────────────────────────────────────
//
// 无状态过滤，作用于 SentenceSplitter 已切出的完整句子。
// 此时块级结构已由 TextFilterStream 处理完毕，只需清理行内 markdown 与 URL/路径。
// 处理顺序很重要——详见 docs/streaming-pipeline.md §filterSentenceForTts。
//
// 注意：ACT 标签（<|ACT:...|>）由 @ema-agent/emotion 包在 engine 内先处理。
// TTS 只接收 apps/core 转发的可见 output_text_delta，此处不做任何 ACT 清理。

const RE_HTML_TAG      = /<\/?[a-zA-Z][^>]*>/g;
const RE_MD_IMAGE      = /!\[[^\]]*\]\([^)]+\)/g;
const RE_MD_LINK       = /\[([^\]]*)\]\([^)]+\)/g;

// 行前缀合并：heading / blockquote / 无序列表 / 有序列表 → 一次 replace
const RE_LINE_PREFIX   = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm;
const RE_HR            = /^[-*_]{3,}\s*$/gm;
const RE_TABLE_SEP     = /^[|:\- ]+\|[|:\- ]*$/gm;
const RE_TABLE_PIPE    = /\|/g;

// 粗体合并：**text** 和 __text__ → 一次 replace + 函数选择捕获组
const RE_BOLD          = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
const RE_ITALIC_STAR   = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g;
const RE_ITALIC_UNDER  = /(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
const RE_STRIKETHROUGH = /~~([^~\n]+)~~/g;
// 限制行内代码内容最长 500 字符，防止不成对反引号导致灾难性回溯
const RE_INLINE_CODE   = /(`{1,2})([^`\n]{1,500}?)\1/g;
const RE_MATH_INLINE   = /\$(?!\d)([^$\n]+)\$/g;
const RE_MATH_LATEX_I  = /\\\([^)]*\\\)/g;

const RE_URL           = /https?:\/\/[^\s)>\]]+/g;
const RE_WIN_PATH      = /[A-Za-z]:\\[^\s,;)]+/g;
const RE_NIX_PATH      = /(?<=^|\s)\/[a-zA-Z0-9_.\/-]{8,}(?=\s|$)/g;

export function filterSentenceForTts(text: string): string {
  // 快速路径：纯文本不含任何 markdown / URL / 路径特征字符，直接返回
  // 覆盖大部分正常对话句子（中文全角标点不触发此检查）
  if (!/[<![\]*_`$#>\-~|:\\/]/.test(text)) return text.trim();

  let out = text;

  out = out.replace(RE_MD_IMAGE,      '(图片)');
  out = out.replace(RE_MD_LINK,       '$1');
  out = out.replace(RE_HTML_TAG,      '');
  out = out.replace(RE_LINE_PREFIX,   '');
  out = out.replace(RE_HR,            '');
  out = out.replace(RE_TABLE_SEP,     '');
  out = out.replace(RE_TABLE_PIPE,    ' ');
  out = out.replace(RE_BOLD,          (_m, s1, s2) => s1 || s2);
  out = out.replace(RE_ITALIC_STAR,   '$1');
  out = out.replace(RE_ITALIC_UNDER,  '$1');
  out = out.replace(RE_STRIKETHROUGH, '$1');

  out = out.replace(RE_INLINE_CODE, '$2');

  out = out.replace(RE_MATH_INLINE,   '(公式)');
  out = out.replace(RE_MATH_LATEX_I,  '(公式)');
  out = out.replace(RE_URL,           '链接');
  out = out.replace(RE_WIN_PATH,      '路径');
  out = out.replace(RE_NIX_PATH,      '路径');
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return out;
}
