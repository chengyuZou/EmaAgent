import * as fs   from 'node:fs';
import * as path from 'node:path';
import { estimateTextTokens } from '@ema-agent/token';

// ── Shared scratchpad filesystem reader ───────────────────────────────────────
//
// Single source of truth for KEY_RE and .meta.json format used by both
// engine.ts (context injection) and any future callers inside this package.
// Do NOT import from @ema-agent/tool-builtin — that creates a dep cycle
// (agent → tool-builtin → tool → contracts vs agent → tool-builtin already in deps).

export const SCRATCHPAD_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const SCRATCHPAD_META_FILE = '.meta.json';

export type ScratchpadMeta = Record<string, { author: string }>;

export function readScratchpadMeta(scratchpadDir: string): ScratchpadMeta {
  const fp = path.join(scratchpadDir, SCRATCHPAD_META_FILE);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')) as ScratchpadMeta; } catch { return {}; }
}

export interface ScratchpadEntry {
  key:             string;
  value:           string;
  tokens:          number;
  author:          string;
}

/**
 * Read all valid key files from scratchpadDir.
 * Returns an empty array when the directory does not exist or has no keys.
 */
export function readScratchpadEntries(scratchpadDir: string): ScratchpadEntry[] {
  if (!fs.existsSync(scratchpadDir)) return [];
  const meta = readScratchpadMeta(scratchpadDir);

  return fs.readdirSync(scratchpadDir)
    .filter(f => SCRATCHPAD_KEY_RE.test(f))
    .flatMap(key => {
      try {
        const value = fs.readFileSync(path.join(scratchpadDir, key), 'utf8');
        return [{ key, value, tokens: estimateTextTokens(value), author: meta[key]?.author ?? 'main' }];
      } catch {
        return [];
      }
    });
}
