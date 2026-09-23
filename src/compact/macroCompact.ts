// 按时间顺序总结全部旧消息, 保留近期原文, 不直接丢弃未总结的前缀.
import type {
  AssistantBlock,
  CallLlm,
  LlmThinking,
  LlmTokenUsage,
  LlmTool,
  Message,
} from '@ema-agent/llm';
import { createLlmCompletion } from '@ema-agent/llm';
import type { SessionMode } from '@ema-agent/session';
import { estimateLlmInputTokens, estimateMessagesTokens } from '@ema-agent/token';
import { compactTokenLimit, createSummaryMessage, fitCompactMessages } from './budget.js';
import { buildCompactPrompt, extractCompactSummary } from './compactPrompt.js';
import type { CompactSettings } from './settings.js';

const MAX_ATTEMPTS = 3;
const RETRY_BUDGET_SCALE = 0.8;
const MIN_SUMMARY_BUDGET_TOKENS = 256;

export interface MacroCompactArgs {
  readonly callLlm: CallLlm;
  readonly sessionMode: SessionMode;
  readonly systemMessages: readonly Message[];
  readonly tools: readonly LlmTool[];
  readonly thinking?: LlmThinking;
  readonly messages: readonly Message[];
  readonly estimatedInputTokens: number;
  readonly settings: Readonly<CompactSettings>;
  readonly modelContextWindow: number;
  readonly modelMaxOutput?: number | null;
  readonly signal?: AbortSignal;
}

export type MacroCompactResult =
  | {
      readonly succeeded: true;
      readonly summary: string;
      readonly messages: Message[];
      readonly afterTokens: number;
      /** 多段摘要包含每次物理调用的用量之和. */
      readonly usage: LlmTokenUsage;
      /** 输入数组从头起被摘要覆盖的消息数. */
      readonly summarizedMessageCount: number;
    }
  | {
      readonly succeeded: false;
      readonly detail: string;
    };

export async function runMacroCompact(args: MacroCompactArgs): Promise<MacroCompactResult> {
  const tokenLimit = compactTokenLimit(args.modelContextWindow, args.settings);
  // 完整请求的估算扣掉工作消息后, 剩余成本在替换历史前后都不变.
  const fixedRequestTokens = args.estimatedInputTokens - estimateMessagesTokens([...args.messages]);
  const suffix = buildSuffixTokens(args.messages);
  const pairs = collectToolPairs(args.messages);
  const summaryEnvelopeTokens = estimateMessagesTokens([
    createSummaryMessage('', args.sessionMode),
  ]);

  // retainStart 左边全部进入摘要, 右边保留原文. 比例只给初始切点,
  // Tool 配对和最终请求预算可以把切点继续移到右边, 但不会丢弃左边的消息.
  const retainStart = expandRetainStartForBudget({
    suffix,
    pairs,
    start: adjustToPairBoundary(
      pairs,
      findTailStart(
        suffix,
        0,
        args.messages.length,
        Math.floor(args.modelContextWindow * args.settings.retainRatio),
      ),
    ),
    fixedRequestTokens,
    summaryEnvelopeTokens,
    tokenLimit,
  });
  if (retainStart === null || retainStart === 0) {
    return { succeeded: false, detail: '近期原文已占满预算, 没有可摘要的旧消息' };
  }

  const tail = args.messages.slice(retainStart);
  // 最终请求需要给摘要消息留出正文空间, 分段摘要的输出上限也不能超过它.
  const finalSummaryBudget = tokenLimit
    - fixedRequestTokens
    - suffix[retainStart]!
    - summaryEnvelopeTokens;
  const instruction: Message = {
    role: 'user',
    content: buildCompactPrompt({ sessionMode: args.sessionMode }),
  };
  const toolsTokens = args.tools.length > 0
    ? estimateLlmInputTokens([], {
        tools: args.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as Record<string, unknown>,
        })),
      }).totalTokens
    : 0;

  // cursor 指向下一条尚未总结的消息. 每段请求都带上上一段摘要,
  // 因此分段间靠摘要传递事实, 不把已经处理的原文重复发送给模型.
  let cursor = 0;
  let summary: string | undefined;
  let usage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };

  while (cursor < retainStart) {
    let budgetScale = 1;
    let lastFailure = '摘要模型未返回结果';
    let completed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      args.signal?.throwIfAborted();
      const previousSummary = summary === undefined
        ? []
        : [createSummaryMessage(summary, args.sessionMode)];
      const fixedInput = [
        ...args.systemMessages,
        ...previousSummary,
        instruction,
      ];
      const chunkBudget = Math.floor(
        (tokenLimit - estimateMessagesTokens(fixedInput) - toolsTokens) * budgetScale,
      );
      // 只缩小当前分段的 end. cursor 直到本段成功才前进, 重试不会跳过消息.
      const end = findChunkEnd(suffix, pairs, cursor, retainStart, chunkBudget);
      if (end <= cursor) {
        return {
          succeeded: false,
          detail: lastFailure === '摘要模型未返回结果'
            ? '单条消息或完整工具调用超过摘要请求预算'
            : `缩小摘要分段后仍无法容纳完整消息: ${lastFailure}`,
        };
      }

      const requestMessages = [
        ...args.systemMessages,
        ...previousSummary,
        ...args.messages.slice(cursor, end),
        instruction,
      ];
      const remainingOutputTokens = args.modelContextWindow
        - estimateMessagesTokens(requestMessages)
        - toolsTokens;
      // 同时受模型硬上限, 请求剩余窗口和最终摘要可容纳空间约束.
      const maxOutputTokens = Math.floor(Math.min(
        args.settings.outputTokens,
        args.modelMaxOutput ?? Number.POSITIVE_INFINITY,
        remainingOutputTokens,
        finalSummaryBudget,
      ));
      if (maxOutputTokens < 1) {
        return { succeeded: false, detail: '摘要请求没有足够的输出预算' };
      }

      try {
        const completion = await createLlmCompletion(args.callLlm({
          messages: requestMessages,
          tools: args.tools,
          ...(args.thinking ? { thinking: args.thinking } : {}),
          maxOutputTokens,
          temperature: 0.2,
          signal: args.signal,
        }));
        usage = addUsage(usage, completion.usage);
        if (completion.stopReason === 'max_tokens') {
          lastFailure = '摘要输出达到模型上限';
          budgetScale *= RETRY_BUDGET_SCALE;
          continue;
        }
        if (completion.stopReason === 'tool_use') {
          return { succeeded: false, detail: '摘要模型尝试调用工具' };
        }
        const nextSummary = extractCompactSummary(collectText(completion.blocks));
        if (!nextSummary) {
          return { succeeded: false, detail: '摘要模型返回了空内容' };
        }
        summary = nextSummary;
        cursor = end;
        completed = true;
        break;
      } catch (error) {
        if (isAbort(error, args.signal)) throw error;
        lastFailure = error instanceof Error ? error.message : String(error);
        if (!isPromptTooLong(lastFailure)) {
          return { succeeded: false, detail: lastFailure };
        }
        // Provider 判超时缩短当前分段, 下一段仍从原 cursor 接着读, 不丢前缀.
        budgetScale *= RETRY_BUDGET_SCALE;
      }
    }

    if (!completed) {
      return {
        succeeded: false,
        detail: `摘要请求连续 ${MAX_ATTEMPTS} 次无法完成: ${lastFailure}`,
      };
    }
  }

  // 全部旧消息成功进入摘要后才组装最终历史. 任何分段失败都不会产出半成品.
  const fitted = fitCompactMessages({
    summary: summary!,
    tail,
    sessionMode: args.sessionMode,
    tokenLimit,
    fixedRequestTokens,
  });
  if (!fitted) {
    return {
      succeeded: false,
      detail: `摘要与近期原文无法放入 ${tokenLimit} Token 的请求预算`,
    };
  }

  return {
    succeeded: true,
    summary: fitted.summary,
    messages: fitted.messages,
    afterTokens: fitted.afterTokens,
    usage,
    summarizedMessageCount: retainStart,
  };
}

/**
 * suffix[i] 是从消息 i 到末尾的估算量, 因此 [a, b) 的量为 suffix[a] - suffix[b].
 * @example 三条消息依次估算为 [10, 20, 40] Token 时, suffix = [70, 60, 40, 0].
 * 消息 [1, 3) 的估算量是 suffix[1] - suffix[3] = 60.
 */
function buildSuffixTokens(messages: readonly Message[]): number[] {
  const suffix = new Array<number>(messages.length + 1).fill(0);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffix[index] = suffix[index + 1]! + estimateMessagesTokens([messages[index]!]);
  }
  return suffix;
}

/**
 * suffix[index] - suffix[to] 随 index 右移递减.
 * 二分找第一个不超过预算的起点, 即预算内最长的近期原文.
 * @example suffix = [70, 60, 40, 0], to = 3, budget = 45 时返回 2.
 * 从消息 2 开始的尾部是 40 Token, 再向左加消息 1 就变成 60 Token.
 */
function findTailStart(
  suffix: readonly number[],
  from: number,
  to: number,
  budget: number,
): number {
  let left = from;
  let right = to;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (suffix[middle]! - suffix[to]! <= budget) {
      right = middle;
    } else {
      left = middle + 1;
    }
  }
  // 没有任何尾部满足预算时, 保留最后一条交给后续硬预算处理.
  return left === to ? Math.max(from, to - 1) : left;
}

/**
 * suffix[cursor] - suffix[end] 随 end 右移递增, 二分找预算内最远的 end.
 * end 若落在 tool_use 和 tool_result 之间就左移到 use 前, 不拆开工具调用.
 * @example suffix = [70, 60, 40, 0], cursor = 0, budget = 30 时先找到 end = 2.
 * 若消息 1 有 tool_use, 消息 2 才有对应结果, 切点 2 会退回消息 1 之前.
 */
function findChunkEnd(
  suffix: readonly number[],
  pairs: ToolPairs,
  cursor: number,
  limit: number,
  budget: number,
): number {
  if (budget <= 0) return cursor;
  let left = cursor;
  let right = limit;
  while (left < right) {
    const middle = Math.floor((left + right + 1) / 2);
    if (suffix[cursor]! - suffix[middle]! <= budget) {
      left = middle;
    } else {
      right = middle - 1;
    }
  }
  return adjustToPairBoundary(pairs, left);
}

/**
 * 比例选出的 tail 若占掉摘要空间, 沿安全切点右移 retainStart.
 * 即把更多旧消息交给摘要, 直到固定成本 + tail + 摘要外壳 + 最小正文预算能放入请求.
 */
function expandRetainStartForBudget(args: {
  readonly suffix: readonly number[];
  readonly pairs: ToolPairs;
  readonly start: number;
  readonly fixedRequestTokens: number;
  readonly summaryEnvelopeTokens: number;
  readonly tokenLimit: number;
}): number | null {
  const nextSafe = buildNextSafeBoundary(args.pairs, args.suffix.length - 1);
  let cut = Math.min(Math.max(0, args.start), args.suffix.length - 1);
  // 强制压缩短历史时比例切点可能为 0, 至少选一段完整消息进入摘要.
  if (cut === 0 && args.suffix.length > 1) {
    cut = nextSafe[1]!;
  }
  for (;;) {
    const tailTokens = args.fixedRequestTokens + args.suffix[cut]!;
    if (tailTokens + args.summaryEnvelopeTokens + MIN_SUMMARY_BUDGET_TOKENS < args.tokenLimit) {
      return cut;
    }
    if (cut >= args.suffix.length - 1) return null;
    cut = nextSafe[cut + 1]!;
  }
}

interface ToolPairs {
  readonly useIndex: ReadonlyMap<string, number>;
  readonly resultsDescending: readonly { toolCallId: string; messageIndex: number }[];
}

// 一条 Message 可能含多个工具块, 配对索引用整条 Message 的位置表示.
function collectToolPairs(messages: readonly Message[]): ToolPairs {
  const useIndex = new Map<string, number>();
  const results: { toolCallId: string; messageIndex: number }[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') {
        useIndex.set(block.id, messageIndex);
      }
      if (message.role === 'user' && block.type === 'tool_result') {
        results.push({ toolCallId: block.toolCallId, messageIndex });
      }
    }
  }
  results.sort((left, right) => right.messageIndex - left.messageIndex);
  return { useIndex, resultsDescending: results };
}

/**
 * 切点 b 位于消息 b 之前. 若 useIndex < b <= resultIndex, 这个切点不安全.
 * 从右到左检查 result, 把不安全切点退到对应 use 之前.
 */
function adjustToPairBoundary(pairs: ToolPairs, boundary: number): number {
  let adjusted = boundary;
  for (const result of pairs.resultsDescending) {
    const useAt = pairs.useIndex.get(result.toolCallId);
    if (useAt === undefined) continue;
    if (result.messageIndex >= adjusted && useAt < adjusted) adjusted = useAt;
  }
  return adjusted;
}

/**
 * 预计算从任意边界 b 往右遇到的第一个安全切点.
 * @example 一条 assistant 消息 0 同时调用 Read#r 和 Grep#g;
 * user 消息 1 返回 r, user 消息 2 返回 g. 切点 b 在消息 b 之前.
 *
 * b:              0  1  2  3
 * Read 跨越:      -  x  -  -
 * Grep 跨越:      -  x  x  -
 * diff:           0 +2 -1 -1
 * 前缀和 depth:   0  2  1  0
 * nextSafe:       0  3  3  3
 *
 * 每对在 useIndex + 1 加一, resultIndex + 1 减一. depth > 0 的切点
 * 会把某个 tool_use 和 tool_result 分开; nextSafe 让预算扩张直接跳到 3.
 */
function buildNextSafeBoundary(pairs: ToolPairs, length: number): number[] {
  const diff = new Array<number>(length + 2).fill(0);
  for (const result of pairs.resultsDescending) {
    const useAt = pairs.useIndex.get(result.toolCallId);
    if (useAt === undefined) continue;
    diff[useAt + 1]! += 1;
    diff[result.messageIndex + 1]! -= 1;
  }
  const nextSafe = new Array<number>(length + 2).fill(length);
  let depth = 0;
  const unsafe = new Array<boolean>(length + 1).fill(false);
  for (let boundary = 0; boundary <= length; boundary += 1) {
    depth += diff[boundary]!;
    unsafe[boundary] = depth > 0;
  }
  for (let boundary = length - 1; boundary >= 0; boundary -= 1) {
    nextSafe[boundary] = unsafe[boundary] ? nextSafe[boundary + 1]! : boundary;
  }
  return nextSafe;
}

function addUsage(total: LlmTokenUsage, call: LlmTokenUsage): LlmTokenUsage {
  return {
    inputTokens: total.inputTokens + call.inputTokens,
    outputTokens: total.outputTokens + call.outputTokens,
    ...(total.cacheReadInputTokens !== undefined || call.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (total.cacheReadInputTokens ?? 0) + (call.cacheReadInputTokens ?? 0) }
      : {}),
    ...(total.cacheWriteInputTokens !== undefined || call.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: (total.cacheWriteInputTokens ?? 0) + (call.cacheWriteInputTokens ?? 0) }
      : {}),
  };
}

function collectText(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((block): block is AssistantBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('');
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function isPromptTooLong(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes('prompt') && (
      normalized.includes('too long') || normalized.includes('size')
    )) ||
    (normalized.includes('context') && (
      normalized.includes('length') || normalized.includes('window')
    ))
  );
}
