// 将摘要、恢复上下文和近期消息收敛到目标模型的硬 Token 预算内。

import type { Message as ModelMessage } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/turn';
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
  /** System Prompt 等不可压缩前缀，始终原样保留。 */
  prefix: ModelMessage[];
  /** Memory、Narrative 与当前 Turn 等不可压缩尾部，始终原样保留。 */
  suffix: ModelMessage[];
  /** Skill 等运行态必须恢复；放不下时整个压缩失败。 */
  requiredRestore: ModelMessage[];
  /** Session Note 等可选恢复状态，预算不足时可以丢弃。 */
  restore: ModelMessage[];
  tail: ModelMessage[];
  executionProfile: ExecutionProfile;
  tokenLimit: number;
  fixedTokens?: number;
}): FittedCompactionContext | null {
  const fixedTokens = Math.max(0, args.fixedTokens ?? 0);
  const estimateTotal = (messages: ModelMessage[]): number =>
    fixedTokens + estimateMessagesTokens(messages);
  if (
    args.tokenLimit <= fixedTokens
    || estimateTotal([
      ...args.prefix,
      ...args.requiredRestore,
      ...args.tail,
      ...args.suffix,
    ]) >= args.tokenLimit
  ) return null;

  const full = buildCandidate(
    args.summary,
    args.prefix,
    args.requiredRestore,
    args.restore,
    args.tail,
    args.suffix,
    args.executionProfile,
  );
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

  const withoutRestore = buildCandidate(
    args.summary,
    args.prefix,
    args.requiredRestore,
    [],
    args.tail,
    args.suffix,
    args.executionProfile,
  );
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
    const messages = buildCandidate(
      summary,
      args.prefix,
      args.requiredRestore,
      [],
      args.tail,
      args.suffix,
      args.executionProfile,
    );
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
  prefix: ModelMessage[],
  requiredRestore: ModelMessage[],
  restore: ModelMessage[],
  tail: ModelMessage[],
  suffix: ModelMessage[],
  executionProfile: ExecutionProfile,
): ModelMessage[] {
  return [
    ...prefix,
    {
      role: 'user',
      content: `<context-summary profile="${executionProfile}">\n${summary}\n</context-summary>`,
    },
    ...requiredRestore,
    ...restore,
    ...tail,
    ...suffix,
  ];
}
