import type {
  LlmMessage, AssistantBlock, UserBlock,
} from '@ema-agent/llm';
import type { ToolResultBlock } from '@ema-agent/contracts';

const CLEARED_PLACEHOLDER = '[Old tool result content cleared — call the tool again if needed]';

/**
 * Walk through the message array and replace stale tool_result content with a
 * short stub. Reduces context size without calling any LLM.
 *
 * Strategy:
 *   - Operate only on tool_result blocks (agent mode artifacts)
 *   - Preserve the most recent `keepRecent` tool_results untouched
 *   - Everything older than the recency window gets its content replaced
 *
 * Returns a NEW messages array — does not mutate the input.
 * Also reports how many tool_results were cleared for telemetry.
 */
export function microCompact(
  messages: LlmMessage[],
  opts: { keepRecent: number } = { keepRecent: 6 },
): { messages: LlmMessage[]; cleared: number } {
  // First pass: find tool_result indices (per-block, in chronological order)
  type ResultLoc = { msgIdx: number; blockIdx: number };
  const locs: ResultLoc[] = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!;
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let b = 0; b < msg.content.length; b++) {
      const blk = msg.content[b]!;
      if (isToolResult(blk)) {
        locs.push({ msgIdx: m, blockIdx: b });
      }
    }
  }

  if (locs.length <= opts.keepRecent) {
    return { messages, cleared: 0 };
  }

  // Determine which indices to clear (everything except the last `keepRecent`)
  const cutoff = locs.length - opts.keepRecent;
  const clearSet = new Set<string>();
  for (let i = 0; i < cutoff; i++) {
    const loc = locs[i]!;
    clearSet.add(`${loc.msgIdx}:${loc.blockIdx}`);
  }

  // Build new messages with the targeted blocks replaced
  const out: LlmMessage[] = messages.map((msg, mIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;
    const newContent: UserBlock[] = msg.content.map((blk, bIdx) => {
      if (!isToolResult(blk)) return blk;
      if (!clearSet.has(`${mIdx}:${bIdx}`)) return blk;
      return {
        type:      'tool_result',
        toolUseId: blk.toolUseId,
        content:   CLEARED_PLACEHOLDER,
        isError:   false,
      } satisfies ToolResultBlock;
    });
    return { role: 'user', content: newContent };
  });

  return { messages: out, cleared: cutoff };
}

// ── Type guards ──────────────────────────────────────────────────────────────

function isToolResult(blk: UserBlock | AssistantBlock): blk is ToolResultBlock {
  return (blk as { type?: string }).type === 'tool_result';
}
