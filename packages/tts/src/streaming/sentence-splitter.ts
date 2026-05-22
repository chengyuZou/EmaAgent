// ── Strict sentence splitter ─────────────────────────────────────────────────
//
// Splits free-form text into utterance-sized chunks for streaming TTS. Designed
// to be invoked as text streams in from the LLM — caller feeds partial text,
// splitter holds a buffer and yields complete sentences as soon as they form.
//
// Rules (intentionally strict — too aggressive splitting produces choppy TTS):
//   - Sentence terminators: . ! ? 。！？…  + Chinese 「」『』 closers.
//   - "." does NOT terminate when:
//       * preceded by a digit AND followed by a digit  (1.5, 3.14)
//       * preceded by a known abbreviation             (Mr. Dr. e.g. i.e. etc.)
//       * followed immediately by a letter/digit       (file.txt — defensive)
//   - "…" (or "...") IS a terminator (counts as ellipsis end).
//   - Minimum sentence length: 4 chars (after trim) — avoids "Ok." "?!" being
//     yielded alone; instead they accumulate into the next sentence.
//   - Maximum buffered length: 200 chars — when reached, force-split at the
//     nearest whitespace, regardless of terminator. Avoids unbounded latency
//     when the model emits long un-punctuated text.

const TERMINATORS = new Set<string>([
  '.', '!', '?', '。', '！', '？', '…',
  // Chinese closing quotes are NOT terminators on their own (they follow one)
]);

const ABBREVIATIONS = new Set<string>([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof',
  'e.g', 'i.e', 'etc', 'cf', 'vs', 'a.m', 'p.m', 'no',
]);

const MIN_SENTENCE_LEN = 4;
const MAX_BUFFER_LEN   = 200;

export interface SentenceChunk {
  /** Monotonic 0-based index of this sentence in the stream. */
  index: number;
  text:  string;
}

export class SentenceSplitter {
  private buffer    = '';
  private nextIndex = 0;

  /**
   * Feed a chunk of streamed text. Yields any complete sentences that
   * formed in the buffer.
   */
  feed(chunk: string): SentenceChunk[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * Signal end of stream. Yields any leftover text as a final sentence
   * (even if shorter than MIN_SENTENCE_LEN).
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
        // Too short on its own; push back to buffer with a separator so it
        // merges with the next sentence rather than yielding tiny fragments.
        this.buffer = piece + ' ' + this.buffer;
        break;
      }

      out.push({ index: this.nextIndex++, text: piece });
    }

    // On final flush, anything left becomes a last sentence even if short.
    if (isFinal && this.buffer.trim().length > 0) {
      out.push({ index: this.nextIndex++, text: this.buffer.trim() });
      this.buffer = '';
    }

    return out;
  }

  /**
   * Find the index of the next valid terminator in `this.buffer`.
   * Returns -1 if no valid terminator is present yet.
   *
   * When `force` is true (length exceeded max), falls back to the nearest
   * whitespace boundary so we don't stall on long un-punctuated text.
   */
  private findCutIndex(force: boolean): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === undefined) break;

      // Ellipsis "..." (three consecutive dots) → split at last dot
      if (ch === '.' && this.buffer[i + 1] === '.' && this.buffer[i + 2] === '.') {
        return i + 2;
      }

      if (!TERMINATORS.has(ch)) continue;
      if (!this.isValidTerminator(i)) continue;
      return i;
    }

    // Force-split at last whitespace before MAX_BUFFER_LEN
    if (this.buffer.length >= MAX_BUFFER_LEN || force) {
      const cutoff = Math.min(this.buffer.length, MAX_BUFFER_LEN);
      const slice  = this.buffer.slice(0, cutoff);
      const lastWs = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
      if (lastWs > 0) return lastWs;
      // No whitespace either — emit whatever we have.
      if (force) return this.buffer.length - 1;
    }

    return -1;
  }

  private isValidTerminator(i: number): boolean {
    const ch   = this.buffer[i];
    const prev = this.buffer[i - 1];
    const next = this.buffer[i + 1];

    if (ch === '.') {
      // 1.5 / 3.14 — digit . digit
      if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false;

      // Abbreviation: walk back to find the word ending at this dot
      if (prev && /[A-Za-z]/.test(prev)) {
        let start = i - 1;
        while (start > 0 && /[A-Za-z.]/.test(this.buffer[start - 1]!)) start--;
        const word = this.buffer.slice(start, i).toLowerCase();
        if (ABBREVIATIONS.has(word)) return false;
      }

      // file.txt — letter . letter (defensive; rare in chat text)
      if (prev && /[A-Za-z]/.test(prev) && next && /[A-Za-z]/.test(next)) return false;
    }

    // Post-terminator must be whitespace, end-of-buffer, or a closing quote.
    // Otherwise we're inside a token (URL, version string, etc.).
    if (next && !/[\s"')\]}」』]/.test(next) && next !== undefined) {
      // Chinese terminators don't require whitespace after
      if (ch === '。' || ch === '！' || ch === '？' || ch === '…') return true;
      return false;
    }

    return true;
  }
}
