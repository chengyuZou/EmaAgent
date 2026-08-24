// 摘要请求与主对话共享 KV 前缀：systemMessages 同字节复用（含缓存断点标记），
// 历史保持结构化原文，压缩指令是尾部最后一条 user 消息。
// 超出摘要模型输入预算时按 Token 从尾部累计保留（findRetainedHistoryStart，一趟精确
// 拟合且配对安全），不做砍半或字符串掐头去尾；Provider 仍判超时按比例缩预算重试。

import type {
  AssistantBlock,
  CallLlm,
  LlmThinking,
  LlmTool,
  Message,
} from '@ema-agent/llm';
import { createLlmCompletion } from '@ema-agent/llm';
import { estimateLlmInputTokens, estimateMessagesTokens } from '@ema-agent/token';
import type { ExecutionProfile } from '@ema-agent/turn-terms';
import { buildCompactPrompt, extractCompactSummary } from './compactPrompt.js';
import { findRetainedHistoryStart } from './safeCut.js';

const MAX_ATTEMPTS = 3;
/** 本地输入预算占窗口比例，余量留给摘要输出。 */
const INPUT_BUDGET_RATIO = 0.85;
/** Provider 判超（本地估算误差）后每次重试的预算缩放。 */
const RETRY_BUDGET_SCALE = 0.8;
const COMPACT_OUTPUT_RATIO = 0.2;
const MIN_COMPACT_OUTPUT_TOKENS = 2_000;

export interface MacroCompactArgs {
  readonly callLlm: CallLlm;
  readonly executionProfile: ExecutionProfile;
  /** 与主对话逐字节一致的系统消息段（含缓存断点标记）；摘要请求的前缀共享来源。 */
  readonly systemMessages: readonly Message[];
  /** 根 Turn 冻结的 Tool 定义（同内容同顺序）；指令已声明工具只是上下文，不得调用。 */
  readonly tools: readonly LlmTool[];
  /** 与主请求一致的中立 thinking 配置；缺省表示未开启。 */
  readonly thinking?: LlmThinking;
  readonly toCompact: readonly Message[];
  readonly modelContextWindow: number;
  readonly signal?: AbortSignal;
}

type MacroCompactResult =
  | {
      readonly succeeded: true;
      readonly summary: string;
      readonly attempts: number;
    }
  | {
      readonly succeeded: false;
      readonly attempts: number;
      readonly detail: string;
    };

export async function runMacroCompact(
  args: MacroCompactArgs,
): Promise<MacroCompactResult> {
  if (args.toCompact.length === 0) {
    return { succeeded: false, attempts: 0, detail: '没有可摘要的历史消息' };
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
  const inputBudget = Math.max(1, Math.floor(args.modelContextWindow * INPUT_BUDGET_RATIO));
  const historyBudget = Math.max(
    1,
    inputBudget - estimateMessagesTokens([...args.systemMessages, instruction(0)]) - toolsTokens,
  );

  let budgetScale = 1;
  let lastFailure = '摘要模型未返回结果';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    args.signal?.throwIfAborted();
    // 从尾部按 Token 预算累计保留；findRetainedHistoryStart 至少保留最新一条。
    const candidate = args.toCompact.slice(
      findRetainedHistoryStart(args.toCompact, Math.floor(historyBudget * budgetScale)),
    );
    const messages = [
      ...args.systemMessages,
      ...candidate,
      instruction(args.toCompact.length - candidate.length),
    ];
    const remainingOutputTokens = Math.max(
      1,
      args.modelContextWindow - estimateMessagesTokens(messages) - toolsTokens,
    );
    const desiredOutputTokens = Math.max(
      MIN_COMPACT_OUTPUT_TOKENS,
      Math.floor(args.modelContextWindow * COMPACT_OUTPUT_RATIO),
    );

    try {
      const completion = await createLlmCompletion(args.callLlm({
        messages,
        tools: args.tools,
        ...(args.thinking ? { thinking: args.thinking } : {}),
        maxOutputTokens: Math.min(desiredOutputTokens, remainingOutputTokens),
        temperature: 0.2,
        signal: args.signal,
      }));
      const summary = extractCompactSummary(collectText(completion.blocks));
      if (!summary) {
        return { succeeded: false, attempts: attempt, detail: '摘要模型返回了空内容' };
      }
      return { succeeded: true, summary, attempts: attempt };
    } catch (error) {
      if (isAbort(error, args.signal)) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (!isPromptTooLong(lastFailure)) {
        return { succeeded: false, attempts: attempt, detail: lastFailure };
      }
      budgetScale *= RETRY_BUDGET_SCALE;
    }
  }

  return {
    succeeded: false,
    attempts: MAX_ATTEMPTS,
    detail: `摘要请求连续 ${MAX_ATTEMPTS} 次超过当前模型输入上限：${lastFailure}`,
  };
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
