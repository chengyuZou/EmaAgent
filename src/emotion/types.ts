// ── ACT tag types ─────────────────────────────────────────────────────────────

export type ActTagKind = 'emotion' | 'motion' | 'delay';

export interface ParsedActTag {
  kind: ActTagKind;
  /** Emotion/motion name, or delay seconds as a numeric string. */
  value: string;
  /** The full tag text, e.g. <|ACT:emotion:happy|> */
  raw: string;
}

// ── Scanner result ────────────────────────────────────────────────────────────

export interface ScanResult {
  /** Delta text with all complete ACT tags stripped. */
  cleaned: string;
  /** All complete ACT tags found in this delta (in order). */
  tags: ParsedActTag[];
}
