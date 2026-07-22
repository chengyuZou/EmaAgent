// 这里把当前 Turn 的共享便笺整理成可控大小的 Agent 上下文。
import { readScratchpadEntries } from './scratchpad-reader.js';

// ── Scratchpad context injection ──────────────────────────────────────────────
//
// Companion to scratchpad-reader.ts:
//   scratchpad-reader  — raw filesystem I/O (read entries, read meta)
//   scratchpad-context — formats entries into an LLM-injectable string
//
// Called before each llm.stream() in turnLoop via getScratchpadContext callback.
// Both the main agent and each sub-agent use the same callback, so they always
// see the current scratchpad state at the start of every iteration.

/** Token budget for scratchpad injection — stays within typical context headroom. */
export const SCRATCHPAD_INJECT_TOKEN_BUDGET = 2000;

/**
 * Read the scratchpad directory and return a formatted context string, or
 * undefined when the scratchpad is empty or the directory does not exist yet.
 *
 * Injection strategy:
 *   - Total estimated tokens ≤ budget  → include full values for all keys
 *   - Total estimated tokens > budget  → include only key names + sizes + author,
 *     prompt the agent to use ScratchpadRead to fetch values it needs
 */
export function buildScratchpadContext(scratchpadDir: string): string | undefined {
  const entries = readScratchpadEntries(scratchpadDir);
  if (entries.length === 0) return undefined;

  const totalTokens = entries.reduce((s, e) => s + e.tokens, 0);
  const lines: string[] = ['[Scratchpad — shared state between you and your sub-agents]'];

  if (totalTokens <= SCRATCHPAD_INJECT_TOKEN_BUDGET) {
    for (const { key, value, tokens, author } of entries) {
      lines.push(`\n## ${key}  (~${tokens} tok, by ${author})\n${value}`);
    }
  } else {
    lines.push(`Total: ~${totalTokens} tokens across ${entries.length} key(s). Values not shown to save context.`);
    lines.push('Use ScratchpadRead to fetch the value you need.\n');
    for (const { key, value, tokens, author } of entries) {
      const preview = value.slice(0, 80).replace(/\n/g, ' ');
      lines.push(`• ${key}  (~${tokens} tok, by ${author})  ${preview}${value.length > 80 ? '…' : ''}`);
    }
  }

  return lines.join('\n');
}
