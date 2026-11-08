type FilterState =
  | 'normal'
  | 'in_opener'
  | 'fenced_code'
  | 'math_block'
  | 'in_closer';

export class TextFilterStream {
  private state: FilterState = 'normal';
  private fenceChar = '';
  // atLineStart=true 时,当前字符在行首位置 - 只有行首才能开/关 fence.
  // 流式分块可能把一行拆成多个 chunk,所以这个标记跨 chunk 保留.
  private atLineStart = true;
  // fence 开头/关闭符的 lookahead 缓冲:代码块需 3 个同类字符才确认开,
  // 数学块需 2 个.所以最多缓存 2 个,第 3 个到达时就能判定了.跨 chunk 保留.
  private lineStartBuffer = '';
  private codeLanguage = ''; // 语言标识可能跨分块到达, 例如 python.

  /** 保留跨分块围栏状态, 在块结束时输出短替换词, 而不是朗读代码正文. */
  feed(chunk: string): string {
    let filteredText = '';
    let position = 0;
    const textLength = chunk.length;

    while (position < textLength) {
      switch (this.state) {

        // fence 只能在行首开,所以行内(非行首)这一段绝不可能开 fence,
        // 可以直接复制到下一个换行, 不必逐字符检查.
        case 'normal': {
          if (!this.atLineStart) {
            const newlineIndex = chunk.indexOf('\n', position);
            if (newlineIndex === -1) {
              // 整个 chunk 剩余都是行内普通文本,直接拼接
              filteredText += chunk.slice(position);
              return filteredText;
            }
            // 批量复制到换行符之前,然后逐字符处理 \n(\n 会把 atLineStart 置回 true)
            filteredText += chunk.slice(position, newlineIndex);
            position = newlineIndex;
            filteredText += this.step(chunk[position]!);
            position++;
            continue;
          }
          break;
        }

        // 语言标识可能跨分块, 收到换行后才进入块内状态.
        case 'in_opener': {
          const newlineIndex = chunk.indexOf('\n', position);
          if (newlineIndex === -1) {
            this.codeLanguage += chunk.slice(position);
            return filteredText;
          }
          this.codeLanguage += chunk.slice(position, newlineIndex);
          position = newlineIndex;
          filteredText += this.step(chunk[position]!);
          position++;
          continue;
        }

        case 'in_closer': {
          const newlineIndex = chunk.indexOf('\n', position);
          if (newlineIndex === -1) return filteredText;
          position = newlineIndex;
          filteredText += this.step(chunk[position]!);
          position++;
          continue;
        }

        // 块内内容直接丢弃,关闭符只在行首出现,所以非行首时整段跳到 \n 即可.
        case 'fenced_code':
        case 'math_block': {
          if (!this.atLineStart) {
            const newlineIndex = chunk.indexOf('\n', position);
            if (newlineIndex === -1) return filteredText;
            position = newlineIndex;
            filteredText += this.step(chunk[position]!);
            position++;
            continue;
          }
          break;
        }

        default:
          break;
      }

      filteredText += this.step(chunk[position]!);
      position++;
    }

    return filteredText;
  }

  /**
   * 流结束时调用.
   * - 未闭合的代码块/数学块 -> emit 替换词
   * - 残留的行首 lookahead 字符 -> 作为普通文本 emit
   */
  flush(): string {
    const remnant = this.lineStartBuffer;
    this.lineStartBuffer = '';
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
    this.codeLanguage = '';
    return remnant;
  }

  private step(ch: string): string {
    switch (this.state) {
      case 'normal':      return this.onNormal(ch);
      case 'in_opener':   return this.onInOpener(ch);
      case 'fenced_code':
      case 'math_block': return this.onBlockContent(ch);
      case 'in_closer':   return this.onInCloser(ch);
    }
  }

  private onNormal(ch: string): string {
    if (this.atLineStart) {
      // extending=true 表示当前字符和已缓存的行首字符同类(连续 `` ` 或 ~ 或 $),
      // 只有连续同类字符才算 fence 开头.比如 "``a" 第三字符是 a,不算 fence 开头.
      const extending = this.lineStartBuffer === '' || this.lineStartBuffer[0] === ch;

      // 代码块 fence:行首 3+ 个连续 ` 或 ~
      if ((ch === '\`' || ch === '~') && extending) {
        this.lineStartBuffer += ch;
        if (this.lineStartBuffer.length >= 3) {
          // 凑够 3 个,确认是代码块 opener,进入 in_opener 等语言标识行
          this.fenceChar    = ch;
          this.lineStartBuffer = '';
          this.codeLanguage      = '';
          this.atLineStart  = false;
          this.state        = 'in_opener';
        }
        return '';
      }

      // 数学块 fence:行首 2+ 个连续 $
      if (ch === '$' && extending) {
        this.lineStartBuffer += ch;
        if (this.lineStartBuffer.length >= 2) {
          this.fenceChar    = '$';
          this.lineStartBuffer = '';
          this.codeLanguage      = '';
          this.atLineStart  = false;
          this.state        = 'in_opener';
        }
        return '';
      }

      // 不是 fence 开头:把缓存的行首字符连同当前字符当普通文本吐出
      const pending     = this.lineStartBuffer;
      this.lineStartBuffer = '';
      this.atLineStart  = ch === '\n';
      return pending + ch;
    }

    if (ch === '\n') {
      this.atLineStart = true;
      return '\n';
    }
    return ch;
  }

  // in_opener 状态:opener 行(如 ```python)的语言标识已在 feed 快速路径收集进 codeLanguage,
  // 这里只等 \n,遇到 \n 就按 fenceChar 转入块内状态(math_block 或 fenced_code).
  // feed() 快速路径已把语言标识字符追加到 codeLanguage;这里只处理 \n.
  private onInOpener(ch: string): string {
    if (ch === '\n') {
      this.atLineStart = true;
      this.state       = this.fenceChar === '$' ? 'math_block' : 'fenced_code';
    }
    return '';
  }

  /** 代码块与数学块共用逐行关闭符处理, 差别只有符号长度和朗读占位文字. */
  private onBlockContent(ch: string): string {
    const mathBlock = this.state === 'math_block';
    const closingLength = mathBlock ? 2 : 3;
    if (this.atLineStart) {
      if (ch === this.fenceChar) {
        this.lineStartBuffer += ch;
        if (this.lineStartBuffer.length >= closingLength) {
          const replacement = mathBlock ? ' (数学公式) ' : this.codeReplacement();
          this.lineStartBuffer = '';
          this.atLineStart = false;
          this.state = 'in_closer';
          return replacement;
        }
        return '';
      }
      this.lineStartBuffer = '';
      this.atLineStart = ch === '\n';
      return '';
    }
    if (ch === '\n') this.atLineStart = true;
    return '';
  }

  // in_closer 状态:closer 行已确认,吃完该行剩余字符直到 \n,然后回 normal.
  private onInCloser(ch: string): string {
    if (ch === '\n') {
      this.atLineStart = true;
      this.state       = 'normal';
    }
    return '';
  }

  private codeReplacement(): string {
    const lang = this.codeLanguage.trim();
    this.codeLanguage = '';
    return lang ? ` (${lang}代码) ` : ' (代码) ';
  }
}

// 输入已由 Stage 处理动作标签, 此处只清理完整句子的 Markdown 和路径.
const RE_HTML_TAG      = /<\/?[a-zA-Z][^>]*>/g;
const RE_MD_IMAGE      = /!\[[^\]]*\]\([^)]+\)/g;
const RE_MD_LINK       = /\[([^\]]*)\]\([^)]+\)/g;

const RE_LINE_PREFIX   = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm;
const RE_HR            = /^[-*_]{3,}\s*$/gm;
const RE_TABLE_SEP     = /^[|:\- ]+\|[|:\- ]*$/gm;
const RE_TABLE_PIPE    = /\|/g;

const RE_BOLD          = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
const RE_ITALIC_STAR   = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g;
const RE_ITALIC_UNDER  = /(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
const RE_STRIKETHROUGH = /~~([^~\n]+)~~/g;
// 限制匹配长度, 避免在没有成对反引号的长文本上反复尝试.
const RE_INLINE_CODE   = /(`{1,2})([^`\n]{1,500}?)\1/g;
const RE_MATH_INLINE   = /\$(?!\d)([^$\n]+)\$/g;
const RE_MATH_LATEX_I  = /\\\([^)]*\\\)/g;

const RE_URL           = /https?:\/\/[^\s)>\]]+/g;
const RE_WIN_PATH      = /[A-Za-z]:\\[^\s,;)]+/g;
const RE_NIX_PATH      = /(?<=^|\s)\/[a-zA-Z0-9_.\/-]{8,}(?=\s|$)/g;

export function filterSentenceForTTS(text: string): string {
  // 快速路径:纯文本不含任何 markdown / URL / 路径特征字符,直接返回
  // 覆盖大部分正常对话句子(中文全角标点不触发此检查)
  if (!/[<![\]*_`$#>\-~|:\\/]/.test(text)) return text.trim();

  let filteredText = text;

  filteredText = filteredText.replace(RE_MD_IMAGE,      '(图片)');
  filteredText = filteredText.replace(RE_MD_LINK,       '$1');
  filteredText = filteredText.replace(RE_HTML_TAG,      '');
  filteredText = filteredText.replace(RE_LINE_PREFIX,   '');
  filteredText = filteredText.replace(RE_HR,            '');
  filteredText = filteredText.replace(RE_TABLE_SEP,     '');
  filteredText = filteredText.replace(RE_TABLE_PIPE,    ' ');
  filteredText = filteredText.replace(RE_BOLD,          (_m, s1, s2) => s1 || s2);
  filteredText = filteredText.replace(RE_ITALIC_STAR,   '$1');
  filteredText = filteredText.replace(RE_ITALIC_UNDER,  '$1');
  filteredText = filteredText.replace(RE_STRIKETHROUGH, '$1');

  filteredText = filteredText.replace(RE_INLINE_CODE, '$2');

  filteredText = filteredText.replace(RE_MATH_INLINE,   '(公式)');
  filteredText = filteredText.replace(RE_MATH_LATEX_I,  '(公式)');
  filteredText = filteredText.replace(RE_URL,           '链接');
  filteredText = filteredText.replace(RE_WIN_PATH,      '路径');
  filteredText = filteredText.replace(RE_NIX_PATH,      '路径');
  filteredText = filteredText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return filteredText;
}
