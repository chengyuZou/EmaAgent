import type { LlmMessage, AssistantBlock, UserBlock, MessageContentPart } from '@ema-agent/contracts';
import type { Message } from './types.js';

/**
 * Convert stored Message[] to provider-safe LlmMessage[] for LLM adapters.
 *
 * Only keeps text blocks for assistant messages and non-tool-result blocks for
 * user messages — thinking, tool_use, and tool_result blocks are unsafe to
 * replay across providers and are deliberately excluded.
 *
 * Shared by ConversationEngine and AgentEngine. Update here when the block
 * format contract in contracts/messages.ts changes.
 */
export function historyToLlmMessages(history: Message[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const msg of history) {
    switch (msg.role) {
      case 'system':
        out.push({ role: 'system', content: typeof msg.blocks === 'string' ? msg.blocks : '' });
        break;
      case 'user':
        if (typeof msg.blocks === 'string') {
          out.push({ role: 'user', content: msg.blocks });
        } else if (Array.isArray(msg.blocks)) {
          const userBlocks = (msg.blocks as UserBlock[]).filter(isReplayableUserBlock);
          if (userBlocks.length > 0) out.push({ role: 'user', content: userBlocks });
        }
        break;
      case 'assistant':
        if (Array.isArray(msg.blocks)) {
          const assistantBlocks = (msg.blocks as AssistantBlock[]).filter(isTextAssistantBlock);
          if (assistantBlocks.length > 0) out.push({ role: 'assistant', content: assistantBlocks });
        }
        break;
    }
  }
  return out;
}

function isTextAssistantBlock(block: unknown): block is AssistantBlock & { type: 'text' } {
  return !!block
    && typeof block === 'object'
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string';
}

function isReplayableUserBlock(block: unknown): block is MessageContentPart {
  return !!block
    && typeof block === 'object'
    && (block as { type?: unknown }).type !== 'tool_result';
}
