// ── 严格句子切分器 ───────────────────────────────────────────────────────────
//
// 把自由文本切成 utterance 大小的块,供流式 TTS 使用。设计为在 LLM
// 文本流入时调用 - 调用方喂入部分文本,切分器持有缓冲,一旦形成完整
// 句子就 yield 出来。
//
// 规则(故意严格 - 切太碎会产生断续的 TTS):
//   - 句子终止符:. ! ? 。！？…  + 中文「」『』闭引号。
//   - "." 不终止的情况:
//       * 前是数字且后是数字  (1.5、3.14)
//       * 前是已知缩写         (Mr. Dr. e.g. i.e. etc.)
//       * 紧跟字母/数字        (file.txt - 防御性)
//   - "…"(或 "...")是终止符(省略号结尾)。
//   - 最小句子长度:4 字符(trim 后)- 避免 "Ok." "?!" 单独 yield;
//     它们会累积到下一句。
//   - 最大缓冲长度:200 字符 - 达到时在最近的空白处强制切分,不管终止符。
//     避免模型输出长无标点文本时延迟无界。

const TERMINATORS = new Set<string>([
  '.', '!', '?', '。', '！', '？',
  // 故意省略 '…' - 单个省略号是停顿,不是句子边界。中文省略号总是成对
  // "……",应累积到下一个真正的终止符。
]);

const ABBREVIATIONS = new Set<string>([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof',
  'e.g', 'i.e', 'etc', 'cf', 'vs', 'a.m', 'p.m', 'no',
]);

const MIN_SENTENCE_LEN = 4;
const MAX_BUFFER_LEN   = 200;

export interface SentenceChunk {
  /** 本句在流中的单调递增 0 起索引。 */
  index: number;
  text:  string;
}

export class SentenceSplitter {
  private buffer    = '';
  private nextIndex = 0;

  /**
   * 喂入一段流式文本。yield 缓冲中已形成的完整句子。
   */
  feed(chunk: string): SentenceChunk[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * 标记流结束。把剩余文本作为最后一句 yield(即使短于 MIN_SENTENCE_LEN)。
   */
  flush(): SentenceChunk[] {
    return this.drain(true);
  }

  private drain(isFinal: boolean): SentenceChunk[] {
    const out: SentenceChunk[] = [];

    while (this.buffer.length > 0) {
      const cut = this.findCutIndex(isFinal);
      if (cut < 0) break;

      const piece = this.buffer.slice(0, cut + 1).trim();
      this.buffer = this.buffer.slice(cut + 1);

      if (piece.length === 0) continue;

      if (piece.length < MIN_SENTENCE_LEN && !isFinal) {
        // 单独太短;推回缓冲加分隔符,让它和下一句合并,而非 yield 碎片。
        this.buffer = piece + ' ' + this.buffer;
        break;
      }

      out.push({ index: this.nextIndex++, text: piece });
    }

    // 最终 flush 时,剩余的都作为最后一句,即使短。
    if (isFinal && this.buffer.trim().length > 0) {
      out.push({ index: this.nextIndex++, text: this.buffer.trim() });
      this.buffer = '';
    }

    return out;
  }

  /**
   * 找 `this.buffer` 中下一个有效终止符的索引。
   * 还没有有效终止符时返回 -1。
   *
   * `force` 为 true(长度超 max)时,回退到最近的空白边界,
   * 避免在长无标点文本上卡住。
   */
  private findCutIndex(force: boolean): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === undefined) break;

      // 省略号 "..."(三个连续点)-> 在最后一个点切分
      if (ch === '.' && this.buffer[i + 1] === '.' && this.buffer[i + 2] === '.') {
        return i + 2;
      }

      if (!TERMINATORS.has(ch)) continue;
      if (!this.isValidTerminator(i)) continue;
      return i;
    }

    // 在 MAX_BUFFER_LEN 前的最后一个空白处强制切分
    if (this.buffer.length >= MAX_BUFFER_LEN || force) {
      const cutoff = Math.min(this.buffer.length, MAX_BUFFER_LEN);
      const slice  = this.buffer.slice(0, cutoff);
      const lastWs = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
      if (lastWs > 0) return lastWs;
      // 也没有空白 - emit 现有的。
      if (force) return this.buffer.length - 1;
    }

    return -1;
  }

  private isValidTerminator(i: number): boolean {
    const ch   = this.buffer[i];
    const prev = this.buffer[i - 1];
    const next = this.buffer[i + 1];

    if (ch === '.') {
      // 1.5 / 3.14 - 数字 . 数字
      if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false;

      // 缩写:回退找以这个点结尾的词
      if (prev && /[A-Za-z]/.test(prev)) {
        let start = i - 1;
        while (start > 0 && /[A-Za-z.]/.test(this.buffer[start - 1]!)) start--;
        const word = this.buffer.slice(start, i).toLowerCase();
        if (ABBREVIATIONS.has(word)) return false;
      }

      // file.txt - 字母 . 字母(防御性;聊天文本少见)
      if (prev && /[A-Za-z]/.test(prev) && next && /[A-Za-z]/.test(next)) return false;
    }

    // 终止符后必须是空白、缓冲末尾或闭引号。
    // 否则我们在一个 token 内(URL、版本号等)。
    if (next && !/[\s"')\]}」』]/.test(next) && next !== undefined) {
      // 中文终止符后不要求空白
      if (ch === '。' || ch === '！' || ch === '？' || ch === '…') return true;
      return false;
    }

    return true;
  }
}
