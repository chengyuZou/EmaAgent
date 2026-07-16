// 这里执行小型上下文压缩，并保留 Agent 后续继续工作所需的关键信息。
import type {
  LlmMessage, AssistantBlock, UserBlock,
} from '@ema-agent/llm';
import type { ToolResultBlock } from '@ema-agent/contracts';

const CLEARED_PLACEHOLDER = '[Old tool result content cleared — call the tool again if needed]';

// Only these tools' results are safe to clear: their output can be
// re-fetched by calling the tool again. Tools whose results carry
// irreversible side-effect records or self-managed storage are excluded:
//   - artifact_*  → ArtifactStore owns the content; result is a slim ref
//   - ask_user    → user's answer is unique, cannot re-fetch
//   - skill_*     → may carry one-shot state
//   - mcp_call    → external side effects, not safely replayable in general
//
// Mirrors Claude Code's COMPACTABLE_TOOLS whitelist (microCompact.ts).
const COMPACTABLE_TOOLS = new Set<string>([
  'Read',
  'Edit',      // edit result is a diff summary — safe to discard
  'Write',     // write result is a confirmation — safe to discard
  'Glob',
  'Grep',
  'bash',
  'powershell',
  'WebFetch',
  'WebSearch',
]);

/**
 * Walk through the message array and replace stale tool_result content with a
 * short stub. Reduces context size without calling any LLM.
 *
 * Strategy:
 *   - Operate only on tool_result blocks whose originating tool is in
 *     COMPACTABLE_TOOLS (re-fetchable output)
 *   - Preserve the most recent `keepRecent` compactable tool_results untouched
 *   - Everything older than the recency window gets its content replaced
 *
 * Returns a NEW messages array — does not mutate the input.
 * Also reports how many tool_results were cleared for telemetry.
 */
export function microCompact(
  messages: LlmMessage[],
  opts: { keepRecent: number } = { keepRecent: 6 },
): { messages: LlmMessage[]; cleared: number } {
  // Build toolUseId → toolName from assistant tool_use blocks.
  // tool_use always precedes its tool_result, so the map is complete by the
  // time we scan results.
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const blk of msg.content) {
      if (isToolUse(blk)) toolNameById.set(blk.id, blk.name);
    }
  }

  // First pass: find COMPACTABLE tool_result indices in chronological order.
  type ResultLoc = { msgIdx: number; blockIdx: number };
  const locs: ResultLoc[] = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!;
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let b = 0; b < msg.content.length; b++) {
      const blk = msg.content[b]!;
      if (!isToolResult(blk)) continue;
      const toolName = toolNameById.get(blk.toolUseId);
      if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) continue; // skip non-compactable
      locs.push({ msgIdx: m, blockIdx: b });
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

function isToolUse(blk: AssistantBlock): blk is AssistantBlock & { type: 'tool_use'; id: string; name: string } {
  return (blk as { type?: string }).type === 'tool_use';
}
