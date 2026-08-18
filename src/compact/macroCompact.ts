// 把旧历史投影为纯文本摘要请求，并在模型拒绝过长输入时有界缩减请求。

import type {
  AssistantBlock,
  LanguageModel,
  Message,
  ToolResultContentPart,
  UserBlock,
} from '@ema-agent/llm';
import { estimateMessagesTokens } from '@ema-agent/token';
import type { ExecutionProfile } from '@ema-agent/turn-terms';
import { buildCompactPrompt, extractCompactSummary } from './compactPrompt.js';

const MAX_ATTEMPTS = 3;
const FIRST_ATTEMPT_INPUT_RATIO = 0.85;
const RETRY_INPUT_RATIO = 0.8;
const COMPACT_OUTPUT_RATIO = 0.2;
const MIN_COMPACT_OUTPUT_TOKENS = 2_000;
const OMITTED_HISTORY_MARKER = '\n\n[部分历史因摘要模型输入上限被省略]\n\n';
export interface MacroCompactArgs {
  readonly llm: LanguageModel;
  readonly providerId: string;
  readonly model: string;
  readonly executionProfile: ExecutionProfile;
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

  const history = formatHistory(args.toCompact);
  let lastFailure = '摘要模型未返回结果';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    args.signal?.throwIfAborted();
    const inputRatio = FIRST_ATTEMPT_INPUT_RATIO * RETRY_INPUT_RATIO ** (attempt - 1);
    const inputTokenLimit = Math.max(1, Math.floor(args.modelContextWindow * inputRatio));
    const prompt = fitPromptToTokenLimit({
      history,
      executionProfile: args.executionProfile,
      inputTokenLimit,
    });
    if (!prompt) {
      return {
        succeeded: false,
        attempts: attempt,
        detail: '摘要指令本身已超过当前模型输入预算',
      };
    }

    const estimatedInputTokens = estimatePromptTokens(prompt);
    const remainingOutputTokens = Math.max(
      1,
      args.modelContextWindow - estimatedInputTokens,
    );
    const desiredOutputTokens = Math.max(
      MIN_COMPACT_OUTPUT_TOKENS,
      Math.floor(args.modelContextWindow * COMPACT_OUTPUT_RATIO),
    );

    try {
      const completion = await args.llm.complete({
        model: args.model,
        messages: [{ role: 'user', content: prompt }],
        maxOutputTokens: Math.min(desiredOutputTokens, remainingOutputTokens),
        temperature: 0.2,
        signal: args.signal,
      });
      const summary = extractCompactSummary(collectText(completion.blocks));
      if (!summary) {
        return {
          succeeded: false,
          attempts: attempt,
          detail: '摘要模型返回了空内容',
        };
      }
      return { succeeded: true, summary, attempts: attempt };
    } catch (error) {
      if (isAbort(error, args.signal)) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (!isPromptTooLong(lastFailure)) {
        return { succeeded: false, attempts: attempt, detail: lastFailure };
      }
    }
  }

  return {
    succeeded: false,
    attempts: MAX_ATTEMPTS,
    detail: `摘要请求连续 ${MAX_ATTEMPTS} 次超过当前模型输入上限：${lastFailure}`,
  };
}

function fitPromptToTokenLimit(args: {
  readonly history: string;
  readonly executionProfile: ExecutionProfile;
  readonly inputTokenLimit: number;
}): string | null {
  const fullPrompt = buildCompactPrompt(args);
  if (estimatePromptTokens(fullPrompt) <= args.inputTokenLimit) return fullPrompt;

  const codePoints = [...args.history];
  let low = 0;
  let high = Math.max(0, codePoints.length - 1);
  let best: string | null = null;
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const history = retainHistoryEdges(codePoints, retained);
    const prompt = buildCompactPrompt({
      executionProfile: args.executionProfile,
      history,
    });
    if (estimatePromptTokens(prompt) <= args.inputTokenLimit) {
      best = prompt;
      low = retained + 1;
    } else {
      high = retained - 1;
    }
  }
  return best;
}

function retainHistoryEdges(codePoints: readonly string[], retained: number): string {
  if (retained >= codePoints.length) return codePoints.join('');
  const prefixLength = Math.floor(retained / 3);
  const suffixLength = retained - prefixLength;
  const prefix = codePoints.slice(0, prefixLength).join('');
  const suffix = suffixLength > 0 ? codePoints.slice(-suffixLength).join('') : '';
  return `${prefix}${OMITTED_HISTORY_MARKER}${suffix}`;
}

function estimatePromptTokens(prompt: string): number {
  return estimateMessagesTokens([{ role: 'user', content: prompt }]);
}

function formatHistory(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (typeof message.content === 'string') {
      lines.push(`[${message.role}]\n${message.content}\n`);
      continue;
    }
    const parts = message.content.map(formatBlock).filter(Boolean);
    lines.push(`[${message.role}]\n${parts.join('\n')}\n`);
  }
  return lines.join('\n');
}

function formatBlock(block: UserBlock | AssistantBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return '';
    case 'tool_use':
      return `<tool_use name="${block.name}">${JSON.stringify(block.args)}</tool_use>`;
    case 'tool_result':
      return `<tool_result${block.isError ? ' error="true"' : ''}>${formatToolResult(block.content)}</tool_result>`;
    case 'image_url':
    case 'image_data':
    case 'audio_data':
    case 'file_url':
    case 'file_data':
      return `[${block.type}]`;
  }
  return '';
}

function formatToolResult(content: string | readonly ToolResultContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => part.type === 'text' ? part.text : `[${part.type}]`)
    .join('\n');
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
