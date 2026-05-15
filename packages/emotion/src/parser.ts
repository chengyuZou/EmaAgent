import type { ParsedActTag, ScanResult } from './types.js';

// ── Regex ─────────────────────────────────────────────────────────────────────

/**
 * Matches complete ACT/DELAY tags:
 *   <|ACT:emotion:happy|>
 *   <|ACT:motion:wave|>
 *   <|DELAY:1.5|>
 *
 * Uses angle-bracket + pipe delimiters to avoid tokenizer collisions
 * with Unicode brackets, parentheses, or square brackets.
 */
const COMPLETE_TAG_RE =
  /<\|(ACT:(emotion|motion):([a-z][a-z0-9_]*)|(DELAY):([\d]+(?:\.[\d]+)?))\|>/g;

/**
 * Detects the start of a potentially incomplete tag anywhere in the string.
 * Used to decide whether to hold the tail in the buffer.
 */
const PARTIAL_TAG_START_RE = /<\|/;

// ── StreamingActScanner ───────────────────────────────────────────────────────

/**
 * Stateful scanner that handles ACT tags split across streaming deltas.
 *
 * Usage:
 *   const scanner = new StreamingActScanner();
 *   for await (const chunk of stream) {
 *     const { cleaned, tags } = scanner.scan(chunk);
 *     // use cleaned for SSE output, tags for state updates
 *   }
 *   const { cleaned } = scanner.flush(); // release any buffered tail
 */
export class StreamingActScanner {
  /**
   * Buffered tail from the previous scan call: a partial tag that starts with `<|`
   * but has not yet received its closing `|>`.
   */
  private tail = '';

  scan(delta: string): ScanResult {
    const input = this.tail + delta;
    const tags: ParsedActTag[] = [];
    const cleanedParts: string[] = [];
    let lastEnd = 0;

    // Reset RE lastIndex because it's shared on the prototype (stateless here
    // since we always create a fresh copy via the literal).
    COMPLETE_TAG_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = COMPLETE_TAG_RE.exec(input)) !== null) {
      // Text before this tag
      cleanedParts.push(input.slice(lastEnd, match.index));
      lastEnd = match.index + match[0]!.length;

      const tag = parseMatch(match);
      if (tag !== null) tags.push(tag);
    }

    // Everything after the last complete tag
    const remainder = input.slice(lastEnd);

    // Check for a partial tag starting somewhere in the remainder.
    // We look for the LAST 【 that has no matching 】 after it.
    const partialIdx = lastPartialStart(remainder);
    if (partialIdx !== -1) {
      cleanedParts.push(remainder.slice(0, partialIdx));
      this.tail = remainder.slice(partialIdx);
    } else {
      cleanedParts.push(remainder);
      this.tail = '';
    }

    return { cleaned: cleanedParts.join(''), tags };
  }

  /**
   * Flush any buffered tail at end-of-stream.
   * Incomplete tags (e.g. model stopped mid-tag) are returned as plain text.
   */
  flush(): ScanResult {
    const cleaned = this.tail;
    this.tail = '';
    return { cleaned, tags: [] };
  }

  reset(): void {
    this.tail = '';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMatch(match: RegExpExecArray): ParsedActTag | null {
  const raw = match[0]!;

  // Group layout (1-indexed capture groups):
  //   1: full inner content (ACT:emotion:X or DELAY:N)
  //   2: "emotion" or "motion"
  //   3: emotion/motion name
  //   4: "DELAY" keyword (if delay branch matched)
  //   5: delay seconds value

  if (match[4] === 'DELAY') {
    return { kind: 'delay', value: match[5]!, raw };
  }

  const actKind = match[2] as 'emotion' | 'motion' | undefined;
  const actValue = match[3];
  if (actKind && actValue) {
    return { kind: actKind, value: actValue, raw };
  }

  return null;
}

/**
 * Returns the index of the last `<|` that has no closing `|>` after it,
 * indicating a partial tag that should be buffered.
 * Returns -1 if no such partial exists.
 */
function lastPartialStart(text: string): number {
  let idx = text.lastIndexOf('<|');
  if (idx === -1) return -1;

  // Check if there's a closing delimiter after this opening
  if (text.indexOf('|>', idx) !== -1) return -1;

  // Also verify this looks like it could be the start of a valid tag
  // (avoid buffering stray `<|` characters that aren't part of an ACT tag)
  const tail = text.slice(idx);
  if (PARTIAL_TAG_START_RE.test(tail) && tail.length < 64) {
    return idx;
  }

  return -1;
}

// ── Stateless strip helper ────────────────────────────────────────────────────

/**
 * Strip all complete ACT tags from a string (non-streaming, for final cleanup).
 */
export function stripActTags(text: string): string {
  COMPLETE_TAG_RE.lastIndex = 0;
  return text.replace(COMPLETE_TAG_RE, '');
}
