/**
 * Token usage 归一化。
 *
 * 不同 provider 的字段命名不一样：
 * - OpenAI Responses: input_tokens / output_tokens / total_tokens
 * - Anthropic Messages: input_tokens / output_tokens，没有 total_tokens
 * - Gemini GenerateContent: promptTokenCount / candidatesTokenCount / totalTokenCount
 * - OpenAI-compatible Chat Completions: prompt_tokens / completion_tokens / total_tokens
 * 统一后上层 turns 表和 usage_report 事件只需要理解一种结构。
 */

import type { ChatCompletionChunk } from "@ema-agent/core-types";

export type TokenUsage = NonNullable<ChatCompletionChunk["usage"]>;

export function normalizeOpenAIUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const inputTokens = readNumber(record, "input_tokens", "prompt_tokens");
  const outputTokens = readNumber(record, "output_tokens", "completion_tokens");
  const totalTokens = readNumber(record, "total_tokens");

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return buildUsage(inputTokens, outputTokens, totalTokens);
}

export function normalizeAnthropicUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const inputTokens = readNumber(record, "input_tokens");
  const outputTokens = readNumber(record, "output_tokens");

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return buildUsage(inputTokens, outputTokens, undefined);
}

export function normalizeGeminiUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const inputTokens = readNumber(record, "promptTokenCount", "prompt_token_count");
  const outputTokens = readNumber(record, "candidatesTokenCount", "candidates_token_count");
  const totalTokens = readNumber(record, "totalTokenCount", "total_token_count");

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return buildUsage(inputTokens, outputTokens, totalTokens);
}

export function normalizeOpenAICompatibleUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const inputTokens = readNumber(record, "prompt_tokens", "input_tokens");
  const outputTokens = readNumber(record, "completion_tokens", "output_tokens");
  const totalTokens = readNumber(record, "total_tokens");

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return buildUsage(inputTokens, outputTokens, totalTokens);
}

/** Anthropic 的 message_delta 只会累计 output_tokens，这里用 latest 覆盖旧值。 */
export function mergeUsage(previous: TokenUsage | undefined, latest: TokenUsage | undefined): TokenUsage | undefined {
  if (!previous) {
    return latest;
  }
  if (!latest) {
    return previous;
  }

  const inputTokens = latest.inputTokens || previous.inputTokens;
  const outputTokens = latest.outputTokens || previous.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: latest.totalTokens || inputTokens + outputTokens,
  };
}

/** 简单 token 估算，用于预算预览；真实计费仍以 provider usage 为准。 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildUsage(inputTokens: number | undefined, outputTokens: number | undefined, totalTokens: number | undefined): TokenUsage {
  const normalizedInput = inputTokens ?? Math.max(0, (totalTokens ?? 0) - (outputTokens ?? 0));
  const normalizedOutput = outputTokens ?? Math.max(0, (totalTokens ?? 0) - normalizedInput);
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: totalTokens ?? normalizedInput + normalizedOutput,
  };
}

function readNumber(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}
