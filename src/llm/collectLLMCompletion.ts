import { LLMStreamProtocolError, throwIfAborted } from './errors.js';
import { createAssistantThinkingBlock } from './message.js';
import type { AssistantBlock } from './message.js';
import type { LLMCompletion, LLMProtocol, LLMStopReason, LLMStreamEvent } from './types.js';
import { updateLLMCallUsage, type LLMTokenUsage } from './usage.js';

/** 本次请求独占这些收集数据. 读完整条流后才返回, 取消或异常由 for-await 关闭迭代器. */
export async function collectLLMCompletion(
  stream: AsyncIterable<LLMStreamEvent>,
  protocol: LLMProtocol,
  signal?: AbortSignal,
): Promise<LLMCompletion> {
  const blocks = new Map<number, AssistantBlock>();
  const thinkingText = new Map<number, string>();
  let usage: LLMTokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: LLMStopReason | undefined;

  for await (const event of stream) {
    throwIfAborted(signal);
    switch (event.type) {
      case 'text_delta': {
        const previous = blocks.get(event.blockIndex);
        const text = previous?.type === 'text' ? previous.text : '';
        blocks.set(event.blockIndex, { type: 'text', text: text + event.delta });
        break;
      }
      case 'thinking_delta': {
        const text = (thinkingText.get(event.blockIndex) ?? '') + event.delta;
        thinkingText.set(event.blockIndex, text);
        blocks.set(event.blockIndex, { type: 'thinking', thinking: text });
        break;
      }
      case 'thinking_complete': {
        const block = createAssistantThinkingBlock(thinkingText.get(event.blockIndex), event.state);
        if (block) blocks.set(event.blockIndex, block);
        thinkingText.delete(event.blockIndex);
        break;
      }
      case 'tool_use_delta':
        // 协议实现负责解析参数, 这里只接收下面的完整工具调用, 不重复解析 JSON.
        break;
      case 'tool_use_complete':
        blocks.set(event.blockIndex, {
          type: 'tool_use', id: event.callId, name: event.name, args: event.args,
        });
        break;
      case 'usage':
        usage = updateLLMCallUsage(usage, event).usage;
        break;
      case 'done':
        // 不提前退出: 某些协议可能在正文结束后才交付最终用量.
        stopReason = event.stopReason;
        break;
    }
  }

  throwIfAborted(signal);
  if (!stopReason) throw new LLMStreamProtocolError(protocol);
  return {
    blocks: [...blocks].sort(([left], [right]) => left - right).map(([, block]) => block),
    usage,
    stopReason,
  };
}
