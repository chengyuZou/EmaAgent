import type { LlmMessage } from '@ema-agent/llm';

// ── Heuristic token estimate ─────────────────────────────────────────────────

/**
 * Cheap, no-API-call token estimation for compaction trigger checks.
 *
 * Heuristic (Anthropic/OpenAI tokenizers behave similarly enough for our use):
 *   English / code  : ~3.8 chars/token  → use 4
 *   Chinese (CJK)   : ~1.5 chars/token  → CJK weight 2.4
 *
 * We split the string roughly into ASCII + non-ASCII and apply different
 * divisors. Off by ±15% in the worst case — acceptable for "should we compact
 * now?" decisions but not for billing.
 *
 * Replace with Anthropic's `count_tokens` API when accuracy actually matters
 * (e.g. token-bar UI showing exact usage).
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk   = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Treat ASCII printable + space as 4-chars-per-token; rest as 1.5-chars
    if (code < 128) ascii++;
    else            cjk++;
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);
}

/**
 * Estimate the input token cost of a full LlmMessage[] array. Each message
 * gets a small per-message overhead (matches what Anthropic / OpenAI add for
 * role markers and message envelopes).
 */
export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 10;   // per-message envelope (role marker, separators)

    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
      continue;
    }

    for (const block of msg.content) {
      if ('text' in block && typeof block.text === 'string') {
        total += estimateTextTokens(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        total += estimateTextTokens(block.thinking);
      } else if (block.type === 'tool_use') {
        total += 20 + estimateTextTokens(JSON.stringify(block.args));
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          total += estimateTextTokens(block.content);
        } else {
          for (const part of block.content) {
            if ('text' in part && typeof part.text === 'string') {
              total += estimateTextTokens(part.text);
            } else {
              total += 200;   // image / file placeholder cost
            }
          }
        }
      }
    }
  }
  return total;
}
