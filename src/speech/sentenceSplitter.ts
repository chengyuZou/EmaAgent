const TERMINATORS = new Set<string>([
  '.', '!', '?', '。', '！', '？',
  // 故意省略 '…' - 单个省略号是停顿,不是句子边界.中文省略号总是成对
  // "……",应累积到下一个真正的终止符.
]);

const ABBREVIATIONS = new Set<string>([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof',
  'e.g', 'i.e', 'etc', 'cf', 'vs', 'a.m', 'p.m', 'no',
]);

const MIN_SENTENCE_LEN = 4;
const MAX_BUFFER_LEN   = 200;

export class SentenceSplitter {
  private buffer = '';

  /** 返回已形成的句子; 不足 4 个 UTF-16 码元的片段会继续等待. */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** 流结束时返回剩余内容, 不再受最小句长限制. 每段仍最多 200 个 UTF-16 码元. */
  flush(): string[] {
    return this.drain(true);
  }

  private drain(isFinal: boolean): string[] {
    const out: string[] = [];

    while (this.buffer.length > 0) {
      const cut = this.findCutIndex(isFinal);
      if (cut < 0) break;

      const piece = this.buffer.slice(0, cut + 1).trim();
      this.buffer = this.buffer.slice(cut + 1);

      if (piece.length === 0) continue;

      out.push(piece);
    }

    return out;
  }

  /**
   * 找 `this.buffer` 中下一个有效终止符的索引.
   * 还没有有效终止符时返回 -1.
   *
   * 流结束或达到单句上限时必须交付, 没有空白也不能超过上限.
   */
  private findCutIndex(force: boolean): number {
    let cutoff = Math.min(this.buffer.length, MAX_BUFFER_LEN);
    const lastCode = this.buffer.charCodeAt(cutoff - 1);
    if (cutoff < this.buffer.length && lastCode >= 0xD800 && lastCode <= 0xDBFF) cutoff--;
    for (let i = 0; i < cutoff; i++) {
      const ch = this.buffer[i];
      if (ch === undefined) break;

      // 省略号 "..."(三个连续点)-> 在最后一个点切分
      if (ch === '.' && i + 2 < cutoff && this.buffer[i + 1] === '.' && this.buffer[i + 2] === '.') {
        if (force || this.buffer.slice(0, i + 3).trim().length >= MIN_SENTENCE_LEN) return i + 2;
        i += 2;
        continue;
      }

      if (!TERMINATORS.has(ch)) continue;
      if (!this.isValidTerminator(i)) continue;
      if (!force && this.buffer.slice(0, i + 1).trim().length < MIN_SENTENCE_LEN) continue;
      return i;
    }

    // 在 MAX_BUFFER_LEN 前的最后一个空白处强制切分
    if (this.buffer.length >= MAX_BUFFER_LEN || force) {
      const slice  = this.buffer.slice(0, cutoff);
      const lastWs = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
      if (lastWs >= MIN_SENTENCE_LEN) return lastWs;
      return cutoff - 1;
    }

    return -1;
  }

  /**
   * 判断 `this.buffer[i]` 是否是有效的句子终止符.
   * 判断规则为
   * - "." 不终止的情况:
   *     * 前是数字且后是数字  (1.5,3.14)
   *     * 前是已知缩写         (Mr. Dr. e.g. i.e. etc.)
   *     * 紧跟字母/数字        (file.txt - 防御性)
   * - 英文终止符后要有空白, 缓冲末尾或闭引号, 避免拆开 URL 和版本号.
   */
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

      // 不拆开 file.txt 这类文件名.
      if (prev && /[A-Za-z]/.test(prev) && next && /[A-Za-z]/.test(next)) return false;
    }

    // 中文句号, 叹号和问号不要求后接空白.
    if (next && !/[\s"')\]}」』]/.test(next) && next !== undefined) {
      if (ch === '。' || ch === '！' || ch === '？') return true;
      return false;
    }

    return true;
  }
}
