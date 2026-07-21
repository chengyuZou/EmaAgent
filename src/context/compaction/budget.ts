// 将摘要、恢复上下文和近期消息收敛到目标模型的硬 Token 预算内。

import type { Message as ModelMessage } from '@ema-agent/llm';
import type { TurnMode } from '@ema-agent/contracts';
import { estimateMessagesTokens } from '@ema-agent/token';

const TRUNCATED_MARKER = '\n\n[摘要已按当前模型上下文预算截断]';

export interface FittedCompactionContext {
  messages: ModelMessage[];
  summary: string;
  afterTokens: number;
  restoreDropped: boolean;
  summaryTruncated: boolean;
}

export function fitCompactionContext(args: {
  summary: string;
  restore: ModelMessage[];
  tail: ModelMessage[];
  mode: TurnMode;
  tokenLimit: number;
  fixedTokens?: number;
}): FittedCompactionContext | null {
  const fixedTokens = Math.max(0, args.fixedTokens ?? 0);
  const estimateTotal = (messages: ModelMessage[]): number =>
    fixedTokens + estimateMessagesTokens(messages);
  if (args.tokenLimit <= fixedTokens || estimateTotal(args.tail) >= args.tokenLimit) return null;

  const full = buildCandidate(args.summary, args.restore, args.tail, args.mode);
  const fullTokens = estimateTotal(full);
  if (fullTokens <= args.tokenLimit) {
    return {
      messages: full,
      summary: args.summary,
      afterTokens: fullTokens,
      restoreDropped: false,
      summaryTruncated: false,
    };
  }

  const withoutRestore = buildCandidate(args.summary, [], args.tail, args.mode);
  const withoutRestoreTokens = estimateTotal(withoutRestore);
  if (withoutRestoreTokens <= args.tokenLimit) {
    return {
      messages: withoutRestore,
      summary: args.summary,
      afterTokens: withoutRestoreTokens,
      restoreDropped: args.restore.length > 0,
      summaryTruncated: false,
    };
  }

  const codePoints = [...args.summary];
  let low = 0;
  let high = codePoints.length;
  let best: FittedCompactionContext | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const summary = `${codePoints.slice(0, middle).join('').trimEnd()}${TRUNCATED_MARKER}`;
    const messages = buildCandidate(summary, [], args.tail, args.mode);
    const afterTokens = estimateTotal(messages);
    if (afterTokens <= args.tokenLimit) {
      best = {
        messages,
        summary,
        afterTokens,
        restoreDropped: args.restore.length > 0,
        summaryTruncated: true,
      };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function buildCandidate(
  summary: string,
  restore: ModelMessage[],
  tail: ModelMessage[],
  mode: TurnMode,
): ModelMessage[] {
  return [
    {
      role: 'user',
      content: `<context-summary mode="${mode}">\n${summary}\n</context-summary>`,
    },
    ...restore,
    ...tail,
  ];
}
