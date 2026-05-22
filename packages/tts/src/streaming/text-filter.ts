// ── Text filter for TTS ──────────────────────────────────────────────────────
//
// Strips non-speakable content before sending text to TTS:
//   - Fenced code blocks   ```...```
//   - Inline code           `foo`
//   - URLs                  https://...
//   - Long file paths       /usr/local/... or D:\foo\bar
//   - Markdown link labels  [text](url) → text only
//   - Markdown image tags   ![alt](src) → dropped
//   - ACT inline markers    <|ACT:emotion:happy|>  <|DELAY:1|>  (consumed by emotion pkg)
//
// Mode-specific aggressiveness:
//   - chat / narrative: light filtering (just URLs + ACT markers; preserve inline code)
//   - agent:            heavy filtering (strip ALL code; user-said agent code blocks
//                       shouldn't be read aloud)

import type { TtsTurnMode } from '@ema-agent/contracts';

export interface TtsFilterOptions {
  turnMode?: TtsTurnMode;
}

const RE_FENCED_CODE = /```[\s\S]*?```/g;
const RE_INLINE_CODE = /`[^`\n]+`/g;
const RE_URL         = /https?:\/\/[^\s)]+/g;
const RE_WIN_PATH    = /[A-Za-z]:\\[^\s]+/g;
const RE_NIX_PATH    = /(?<=^|\s)\/[A-Za-z0-9_./-]{8,}(?=\s|$)/g;
const RE_MD_IMAGE    = /!\[[^\]]*\]\([^)]+\)/g;
const RE_MD_LINK     = /\[([^\]]+)\]\([^)]+\)/g;
const RE_ACT_MARKER  = /<\|(?:ACT|DELAY)[^>]*\|>/g;

/**
 * Apply the filter and return cleaned text. Idempotent.
 */
export function filterTextForTts(text: string, opts: TtsFilterOptions): string {
  let out = text;

  out = out.replace(RE_ACT_MARKER, '');
  out = out.replace(RE_MD_IMAGE,   '');
  out = out.replace(RE_MD_LINK,    '$1');

  if (opts.turnMode === 'agent') {
    out = out.replace(RE_FENCED_CODE, ' （代码段已省略） ');
    out = out.replace(RE_INLINE_CODE, '');
  } else {
    out = out.replace(RE_FENCED_CODE, ' （代码段） ');
  }

  out = out.replace(RE_URL,      '链接');
  out = out.replace(RE_WIN_PATH, '路径');
  out = out.replace(RE_NIX_PATH, '路径');

  // Collapse runs of whitespace
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return out;
}
