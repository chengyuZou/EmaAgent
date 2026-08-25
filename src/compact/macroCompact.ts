// 摘要压缩的完整实现：窗口截断（一刀切）→ 近期保留选取（含硬预算扩张）→
// 候选收缩 → 摘要调用 → 预算拟合。所有 Cut（含配对安全）都是本文件内部职责，
// 不离开这里；调用方给完整工作历史，不关心内部怎么切。
//
// 切割与淘汰记账：85% 触发线（compactTokenLimit）一刀切丢弃最旧前缀；摘要模型
// 输入预算装不下时候选继续从头部收缩（含 Provider 判超重试的追加收缩）。两段
// 淘汰合并为 droppedMessageCount/droppedTokens 如实上报——游标覆盖到 retainStart
// 是对的，但用户必须看到全部未进入摘要的量，指令里的"最早 N 条未纳入"只对模型说。
import type {
  AssistantBlock,
  CallLlm,
  LlmThinking,
  LlmTokenUsage,
  LlmTool,
  Message,
} from '@ema-agent/llm';
import { createLlmCompletion } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/session';
import { estimateLlmInputTokens, estimateMessagesTokens } from '@ema-agent/token';
import { compactTokenLimit, fitCompactHistory } from './budget.js';
import { buildCompactPrompt, extractCompactSummary } from './compactPrompt.js';
import type { CompactSettings } from './settings.js';

const MAX_ATTEMPTS = 3;
/** Provider 判超（本地估算误差）后每次重试的预算缩放。 */
const RETRY_BUDGET_SCALE = 0.8;
/** 拟合前的摘要最小占位：tail + 外部成本 + 它 ≥ 触发线时就该把保留线右移。 */
const MIN_SUMMARY_BUDGET_TOKENS = 256;

export interface MacroCompactArgs {
  readonly callLlm: CallLlm;
  readonly executionProfile: ExecutionProfile;
  /** 与主对话逐字节一致的系统消息段（含缓存断点标记）；摘要请求的前缀共享来源。 */
  readonly systemMessages: readonly Message[];
  /** 根 Turn 冻结的 Tool 定义（同内容同顺序）；指令已声明工具只是上下文，不得调用。 */
  readonly tools: readonly LlmTool[];
  /** 与主请求一致的中立 thinking 配置；缺省表示未开启。 */
  readonly thinking?: LlmThinking;
  /** 完整工作历史（Micro 之后）；窗口截断与近期保留都在本函数内部完成。 */
  readonly toCompact: readonly Message[];
  /** 完整候选请求的本地估算（≥ toCompact 本身，差额即历史外成本）。 */
  readonly estimatedInputTokens: number;
  readonly settings: Readonly<CompactSettings>;
  readonly modelContextWindow: number;
  /** 当前模型的输出硬上限（ProviderModel 事实，null/缺省 = 未知）。 */
  readonly modelMaxOutput?: number | null;
  readonly signal?: AbortSignal;
}

export type MacroCompactResult =
  | {
      readonly succeeded: true;
      /** 预算拟合后的最终摘要，持久化必须使用这一份。 */
      readonly summary: string;
      /** 摘要消息 + 原文保留尾，下一次装配直接使用。 */
      readonly history: Message[];
      readonly afterTokens: number;
      /** 摘要调用的最终 usage（收完的 completion 快照）；调用方据此记账。 */
      readonly usage: LlmTokenUsage;
      /** 被摘要替换 + 被淘汰的输入消息数（相对 toCompact 下标），供游标映射。 */
      readonly summarizedMessageCount: number;
      /** 实际被淘汰（未进入摘要）的总消息条数与估算 token（一刀切 + 候选收缩）。 */
      readonly droppedMessageCount: number;
      readonly droppedTokens: number;
    }
  | {
      readonly succeeded: false;
      readonly detail: string;
    };

export async function runMacroCompact(
  args: MacroCompactArgs,
): Promise<MacroCompactResult> {
  const { settings } = args;
  const tokenLimit = compactTokenLimit(args.modelContextWindow, settings);
  const tokensOutsideHistory = Math.max(
    0,
    args.estimatedInputTokens - estimateMessagesTokens([...args.toCompact]),
  );

  // 后缀 Token 累计建一次，后续所有边界查询 O(1)；配对安全边界表同一次建成。
  const suffix = buildSuffixTokens(args.toCompact);
  const pairs = collectToolPairs(args.toCompact);

  // 单趟双边界：85% 触发线一刀切（truncateStart），16%（retainRatio）近期保留（retainStart）。
  const truncateStart = adjustToPairBoundary(
    pairs,
    findTailStart(suffix, 0, args.toCompact.length, tokenLimit),
  );
  // 硬预算优先于比例：保留尾+外部成本+摘要最小预算放不下触发线时，保留线右移
  // （更多内容交给摘要，例如单条超大消息也会进入 Macro 而不是误判为历史不足）。
  const retainStart = expandRetainStartForBudget({
    messages: args.toCompact,
    suffix,
    pairs,
    start: adjustToPairBoundary(
      pairs,
      findTailStart(
        suffix,
        0,
        args.toCompact.length,
        Math.floor(args.modelContextWindow * settings.retainRatio),
      ),
    ),
    tokensOutsideHistory,
    tokenLimit,
  });
  if (retainStart === null) {
    return {
      succeeded: false,
      detail: '近期原文已占满预算，没有可摘要的旧前缀',
    };
  }
  const head = args.toCompact.slice(truncateStart, retainStart);
  const tail = args.toCompact.slice(retainStart);
  if (head.length === 0) {
    return {
      succeeded: false,
      detail: '近期原文已占满预算，没有可摘要的旧前缀',
    };
  }

  // 指令固定在尾部（前缀命中区之外）；被预算裁掉的最旧部分在此如实告知摘要模型。
  const instruction = (omittedCount: number): Message => ({
    role: 'user',
    content: buildCompactPrompt({ executionProfile: args.executionProfile })
      + (omittedCount > 0
        ? `\n\n（最早 ${omittedCount} 条消息因摘要模型输入预算未纳入，直接从现有首条开始摘要）`
        : ''),
  });

  // 摘要请求与主请求同口径发送完整 tools（指令已声明工具只是上下文）：tools token
  // 是固定开销，必须进入同一输入预算，否则小窗口模型会因 tools 漏算而假失败。
  const toolsTokens = args.tools.length > 0
    ? estimateLlmInputTokens([], {
        tools: args.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as Record<string, unknown>,
        })),
      }).totalTokens
    : 0;
  // 摘要模型装得下的历史预算：与窗口截断同一条 85% 线，扣除系统段、指令与 tools。
  const historyBudget = Math.max(
    1,
    tokenLimit
      - estimateMessagesTokens([...args.systemMessages, instruction(0)])
      - toolsTokens,
  );

  let budgetScale = 1;
  let lastFailure = '摘要模型未返回结果';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    args.signal?.throwIfAborted();
    // 候选按摘要模型输入预算从头部继续收缩（配对安全）；成功那次的收缩量计入淘汰。
    const candidateStart = adjustToPairBoundary(
      pairs,
      findTailStart(
        suffix,
        truncateStart,
        retainStart,
        Math.floor(historyBudget * budgetScale),
      ),
    );
    const candidate = args.toCompact.slice(candidateStart, retainStart);
    const messages = [
      ...args.systemMessages,
      ...candidate,
      instruction(candidateStart - truncateStart),
    ];
    const remainingOutputTokens = Math.max(
      1,
      args.modelContextWindow - estimateMessagesTokens(messages) - toolsTokens,
    );

    try {
      const completion = await createLlmCompletion(args.callLlm({
        messages,
        tools: args.tools,
        ...(args.thinking ? { thinking: args.thinking } : {}),
        maxOutputTokens: Math.max(
          1,
          Math.min(
            settings.outputTokens,
            args.modelMaxOutput ?? Number.POSITIVE_INFINITY,
            remainingOutputTokens,
          ),
        ),
        temperature: 0.2,
        signal: args.signal,
      }));
      const summary = extractCompactSummary(collectText(completion.blocks));
      if (!summary) {
        return { succeeded: false, detail: '摘要模型返回了空内容' };
      }
      // 摘要 + 原文保留尾适配硬预算；放不下时二分裁剪摘要正文，仍放不下则如实失败。
      const fitted = fitCompactHistory({
        summary,
        tail,
        executionProfile: args.executionProfile,
        tokenLimit,
        tokensOutsideHistory,
      });
      if (!fitted) {
        return {
          succeeded: false,
          detail: `摘要与近期历史无法放入 ${tokenLimit} Token 的历史预算`,
        };
      }
      return {
        succeeded: true,
        summary: fitted.summary,
        history: fitted.history,
        afterTokens: fitted.afterTokens,
        usage: completion.usage,
        summarizedMessageCount: retainStart,
        // 两段淘汰合并：一刀切（truncateStart）+ 成功那次的候选收缩偏移。
        droppedMessageCount: candidateStart,
        droppedTokens: suffix[0]! - suffix[candidateStart]!,
      };
    } catch (error) {
      if (isAbort(error, args.signal)) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (!isPromptTooLong(lastFailure)) {
        return { succeeded: false, detail: lastFailure };
      }
      budgetScale *= RETRY_BUDGET_SCALE;
    }
  }

  return {
    succeeded: false,
    detail: `摘要请求连续 ${MAX_ATTEMPTS} 次超过当前模型输入上限：${lastFailure}`,
  };
}

// ── 切割与配对安全（内部实现） ────────────────────────────────────────────────

/** 后缀 Token 累计：suffix[i] = messages[i:] 的估算总量。建一次，边界查询 O(1)。 */
function buildSuffixTokens(messages: readonly Message[]): number[] {
  const suffix = new Array<number>(messages.length + 1).fill(0);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffix[index] = suffix[index + 1]! + estimateMessagesTokens([messages[index]!]);
  }
  return suffix;
}

/**
 * [from, to) 区间内满足"尾部 ≤ budget"的最左下标；区间内最新一条永远保留
 * （它独自超预算时返回 to - 1）。suffix 非递增，正向首个命中即最大尾部。
 */
function findTailStart(
  suffix: readonly number[],
  from: number,
  to: number,
  budget: number,
): number {
  for (let index = from; index < to; index += 1) {
    if (suffix[index]! - suffix[to]! <= budget) return index;
  }
  return Math.max(from, to - 1);
}

/**
 * 硬预算优先于比例：保留尾 + 外部成本 + 摘要最小预算放不下触发线时，把保留线
 * 右移（更多内容交给摘要）直到能放下；连空 tail 都放不下返回 null（无解，
 * 是历史外成本本身超线，不是历史的错）。
 */
function expandRetainStartForBudget(args: {
  readonly messages: readonly Message[];
  readonly suffix: readonly number[];
  readonly pairs: ToolPairs;
  readonly start: number;
  readonly tokensOutsideHistory: number;
  readonly tokenLimit: number;
}): number | null {
  const nextSafe = buildNextSafeBoundary(args.pairs, args.messages.length);
  let cut = Math.min(Math.max(0, args.start), args.messages.length);
  for (;;) {
    const tailTokens = args.tokensOutsideHistory + args.suffix[cut]!;
    if (tailTokens + MIN_SUMMARY_BUDGET_TOKENS < args.tokenLimit) return cut;
    if (cut >= args.messages.length) return null;
    cut = nextSafe[cut + 1]!;
  }
}

interface ToolPairs {
  /** tool_use id → 消息下标。 */
  readonly useIndex: ReadonlyMap<string, number>;
  /** tool_result 的 (toolCallId, 消息下标)，按下标降序。 */
  readonly resultsDescending: readonly { toolCallId: string; messageIndex: number }[];
}

/** compact 的输入来自 deriveLlmHistory，上游只放行完整配对；这里只消费配对关系不再校验。 */
function collectToolPairs(messages: readonly Message[]): ToolPairs {
  const useIndex = new Map<string, number>();
  const results: { toolCallId: string; messageIndex: number }[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const type = (block as { type?: string }).type;
      if (message.role === 'assistant' && type === 'tool_use') {
        const id = (block as { id?: string }).id;
        if (id) useIndex.set(id, messageIndex);
      }
      if (message.role === 'user' && type === 'tool_result') {
        const toolCallId = (block as { toolCallId?: string }).toolCallId;
        if (toolCallId) results.push({ toolCallId, messageIndex });
      }
    }
  }
  results.sort((a, b) => b.messageIndex - a.messageIndex);
  return { useIndex, resultsDescending: results };
}

/**
 * 边界只往左拉：凡 result 在边界内（i ≥ boundary）而其 use 在边界外（j < boundary），
 * 边界移到 j。result 降序处理，每条一次，O(pairs)。use 缺失说明配对在上游已损坏，
 * 按无约束处理（不归这里裁决）。
 */
function adjustToPairBoundary(pairs: ToolPairs, boundary: number): number {
  let adjusted = boundary;
  for (const result of pairs.resultsDescending) {
    const useAt = pairs.useIndex.get(result.toolCallId);
    if (useAt === undefined) continue;
    if (result.messageIndex >= adjusted && useAt < adjusted) {
      adjusted = useAt;
    }
  }
  return adjusted;
}

/**
 * 预计算"≥ b 的第一个配对安全边界"表：边界 b 不安全 ⟺ 存在配对 (use j, result i)
 * 使 j < b ≤ i（切点把结果留在 tail 却丢了调用）。建表 O(n + pairs)，查询 O(1)。
 */
function buildNextSafeBoundary(pairs: ToolPairs, length: number): number[] {
  const diff = new Array<number>(length + 2).fill(0);
  for (const result of pairs.resultsDescending) {
    const useAt = pairs.useIndex.get(result.toolCallId);
    if (useAt === undefined) continue;
    diff[useAt + 1]! += 1;
    diff[result.messageIndex + 1]! -= 1;
  }
  const unsafe = new Array<boolean>(length + 2).fill(false);
  let depth = 0;
  for (let boundary = 0; boundary <= length; boundary += 1) {
    depth += diff[boundary]!;
    unsafe[boundary] = depth > 0;
  }
  const nextSafe = new Array<number>(length + 2).fill(length);
  for (let boundary = length - 1; boundary >= 0; boundary -= 1) {
    nextSafe[boundary] = unsafe[boundary] ? nextSafe[boundary + 1]! : boundary;
  }
  return nextSafe;
}

function collectText(blocks: readonly AssistantBlock[]): string {
  return blocks
    .filter((block): block is AssistantBlock & { type: 'text' } => block.type === 'text')
    .map((block) => block.text)
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
