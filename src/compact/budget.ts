// 把摘要、必须恢复的运行状态和近期历史收敛到总输入硬预算内。

import type { Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/session';
import { estimateMessagesTokens } from '@ema-agent/token';

const TRUNCATED_MARKER = '\n\n[摘要已按当前模型上下文预算截断]';

interface FittedCompactHistory {
  readonly history: Message[];
  /** history 中实际使用的摘要，可能比模型原始输出更短。 */
  readonly summary: string;
  readonly afterTokens: number;
}

export function fitCompactHistory(args: {
  readonly summary: string;
  readonly tail: readonly Message[];
  readonly executionProfile: ExecutionProfile;
  readonly tokenLimit: number;
  readonly tokensOutsideHistory: number;
}): FittedCompactHistory | null {
  const tokensOutsideHistory = Math.max(0, args.tokensOutsideHistory);
  const estimateTotal = (history: readonly Message[]): number =>
    tokensOutsideHistory + estimateMessagesTokens([...history]);
  if (
    args.tokenLimit <= tokensOutsideHistory ||
    estimateTotal(args.tail) >= args.tokenLimit
  ) {
    return null;
  }

  const full = buildHistory(
    args.summary,
    args.tail,
    args.executionProfile,
  );
  const fullTokens = estimateTotal(full);
  if (fullTokens <= args.tokenLimit) {
    return {
      history: full,
      summary: args.summary,
      afterTokens: fullTokens,
    };
  }

  const codePoints = [...args.summary];
  let low = 0;
  let high = codePoints.length;
  let best: FittedCompactHistory | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const summary = `${codePoints.slice(0, middle).join('').trimEnd()}${TRUNCATED_MARKER}`;
    const history = buildHistory(
      summary,
      args.tail,
      args.executionProfile,
    );
    const afterTokens = estimateTotal(history);
    if (afterTokens <= args.tokenLimit) {
      best = { history, summary, afterTokens };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function buildHistory(
  summary: string,
  tail: readonly Message[],
  executionProfile: ExecutionProfile,
): Message[] {
  return [
    {
      role: 'user',
      content: `<context-summary profile="${executionProfile}">\n${summary}\n</context-summary>`,
    },
    ...tail,
  ];
}
