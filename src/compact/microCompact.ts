// 执行零模型调用的微压缩, 保留近期工具结果
import type {
  Message as ModelMessage, AssistantBlock, UserBlock, ToolResultBlock,
} from '@ema-agent/llm';

const CLEARED_PLACEHOLDER = '[Old tool result content cleared — call the tool again if needed]';

// Message 只保存模型可见的 Tool 名称, 因此按名称识别可重新获取的只读结果.
// AskUser, Skill, MCP, Shell 和写入类工具不在集合中, 避免清掉不可重放的事实.
const COMPACTABLE_TOOLS = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
]);

/**
 * 遍历消息数组, 将过时的 tool_result 内容替换为简短占位符, 无需调用 LLM.
 * 仅对其来源工具在 COMPACTABLE_TOOLS 中的 tool_result 块进行操作(可重新获取的输出)
 * 保留最近的 `keepRecentToolResults` 个可压缩的 tool_results 不变
 * 超过最近窗口的所有内容都将其内容替换为占位符
 */
export function microCompact(
  messages: readonly ModelMessage[],
  opts: { keepRecentToolResults: number } = { keepRecentToolResults: 6 },
): ModelMessage[] {
  // 先收集 toolCallId 到 toolName 的映射, 再处理跨消息的 Tool 调用与结果.
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const blk of msg.content) {
      if (isToolUse(blk)) toolNameById.set(blk.id, blk.name);
    }
  }

  // 按时间顺序找到可压缩的 tool_result 位置.
  type ResultLoc = { msgIdx: number; blockIdx: number };
  const locs: ResultLoc[] = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!;
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let b = 0; b < msg.content.length; b++) {
      const blk = msg.content[b]!;
      if (!isToolResult(blk) || blk.isError) continue;
      const toolName = toolNameById.get(blk.toolCallId);
      if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) continue;
      locs.push({ msgIdx: m, blockIdx: b });
    }
  }

  if (locs.length <= opts.keepRecentToolResults) {
    return [...messages];
  }

  // 最近的 keepRecentToolResults 个结果保持原文.
  const cutoff = locs.length - opts.keepRecentToolResults;
  const clearSet = new Set<string>();
  for (let i = 0; i < cutoff; i++) {
    const loc = locs[i]!;
    clearSet.add(`${loc.msgIdx}:${loc.blockIdx}`);
  }

  // 只复制发生替换的 user 内容, 其他消息保留原引用.
  const out: ModelMessage[] = messages.map((msg, mIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;
    const newContent: UserBlock[] = msg.content.map((blk, bIdx) => {
      if (!isToolResult(blk)) return blk;
      if (!clearSet.has(`${mIdx}:${bIdx}`)) return blk;
      return {
        type:      'tool_result',
        toolCallId: blk.toolCallId,
        content:   CLEARED_PLACEHOLDER,
        isError:   blk.isError,
      } satisfies ToolResultBlock;
    });
    return { role: 'user', content: newContent };
  });

  return out;
}

function isToolResult(blk: UserBlock | AssistantBlock): blk is ToolResultBlock {
  return (blk as { type?: string }).type === 'tool_result';
}

function isToolUse(blk: AssistantBlock): blk is AssistantBlock & { type: 'tool_use'; id: string; name: string } {
  return (blk as { type?: string }).type === 'tool_use';
}
