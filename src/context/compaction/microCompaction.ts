// 执行零模型调用的微压缩，并保留 Agent 继续工作所需的近期工具结果。
import type {
  Message as ModelMessage, AssistantBlock, UserBlock, ToolResultBlock,
} from '@ema-agent/llm';

const CLEARED_PLACEHOLDER = '[Old tool result content cleared — call the tool again if needed]';

// Only these tools' results are safe to clear: their output can be
// re-fetched by calling the tool again. Tools whose results carry
// irreversible side-effect records or self-managed storage are excluded:
//   - Artifact*   → ArtifactStore owns the content; result is a slim ref
//   - AskUser*    → user's answer is unique, cannot re-fetch
//   - SkillCall   → may carry one-shot state
//   - mcp_call    → external side effects, not safely replayable in general
//
// Mirrors Claude Code's COMPACTABLE_TOOLS whitelist (microCompact.ts).
const COMPACTABLE_TOOLS = new Set<string>([
  'Read',
  'Edit',      // edit result is a diff summary — safe to discard
  'Write',     // write result is a confirmation — safe to discard
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'WebFetch',
  'WebSearch',
]);

/**
 * 遍历消息数组，将过时的 tool_result 内容替换为简短的占位符。减少上下文大小而无需调用任何 LLM。
 *
 * 策略:
 *   - 仅对其来源工具在 COMPACTABLE_TOOLS 中的 tool_result 块进行操作(可重新获取的输出)
 *   - 保留最近的 `keepRecent` 个可压缩的 tool_results 不变
 *   - 超过最近窗口的所有内容都将其内容替换为占位符
 *
 * 返回一个新的消息数组——不会修改输入。
 * 还会报告清除的 tool_results 数量以进行遥测。
 */
export function microCompact(
  messages: ModelMessage[],
  opts: { keepRecent: number } = { keepRecent: 6 },
): { messages: ModelMessage[]; cleared: number } {
  // 从 assistant 的 tool_use 块中构建 toolUseId → toolName 映射。
  // tool_use 总是先于其 tool_result，因此在扫描结果时映射已完整。
  // TODO 这俩不能一次遍历 ?
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const blk of msg.content) {
      if (isToolUse(blk)) toolNameById.set(blk.id, blk.name);
    }
  }

  // 第一次遍历：按时间顺序找到可压缩的 tool_result 索引。
  type ResultLoc = { msgIdx: number; blockIdx: number };
  const locs: ResultLoc[] = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!;
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let b = 0; b < msg.content.length; b++) {
      const blk = msg.content[b]!;
      if (!isToolResult(blk)) continue;
      const toolName = toolNameById.get(blk.toolUseId);
      if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) continue;
      locs.push({ msgIdx: m, blockIdx: b });
    }
  }

  if (locs.length <= opts.keepRecent) {
    return { messages, cleared: 0 };
  }

  // 决定哪些索引需要清除(除了最近的 keepRecent 个)
  const cutoff = locs.length - opts.keepRecent;
  const clearSet = new Set<string>();
  for (let i = 0; i < cutoff; i++) {
    const loc = locs[i]!;
    clearSet.add(`${loc.msgIdx}:${loc.blockIdx}`);
  }

  // 建立新的消息数组，将目标块替换为占位符
  const out: ModelMessage[] = messages.map((msg, mIdx) => {
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
