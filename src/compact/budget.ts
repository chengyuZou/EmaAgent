import type { Message } from '@ema-agent/llm';
import type { SessionMode } from '@ema-agent/session';
import { estimateMessagesTokens } from '@ema-agent/token';
import type { CompactSettings } from './settings.js';

/**
 * 自动压缩和 force 路径共用同一条输入预算线.
 * 手动 /compact 的准入下限由命令入口单独判断.
 */
export function compactTokenLimit(
  contextWindow: number,
  settings: Readonly<CompactSettings>,
): number {
  return Math.max(1, Math.floor(contextWindow * (1 - settings.bufferRatio)));
}

interface FittedCompactMessages {
  readonly messages: Message[];
  readonly summary: string;
  readonly afterTokens: number;
}

export function fitCompactMessages(args: {
  readonly summary: string;
  readonly tail: readonly Message[];
  readonly sessionMode: SessionMode;
  readonly tokenLimit: number;
  readonly fixedRequestTokens: number;
}): FittedCompactMessages | null {
  const messages = [createSummaryMessage(args.summary, args.sessionMode), ...args.tail];
  const afterTokens = args.fixedRequestTokens + estimateMessagesTokens(messages);
  if (afterTokens > args.tokenLimit) return null;
  return { messages, summary: args.summary, afterTokens };
}

export function createSummaryMessage(summary: string, sessionMode: SessionMode): Message {
  return {
    role: 'user',
    content: `<context-summary mode="${sessionMode}">\n${summary}\n</context-summary>`,
  };
}
