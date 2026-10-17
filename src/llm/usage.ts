/** 一次请求的累计 Token 用量. 缓存读取和写入数量已包含在 inputTokens 中. */
export interface LLMTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

export interface ProviderUsageInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number | null;
  readonly cacheWriteInputTokens?: number | null;
}

export function createLLMTokenUsage(input: ProviderUsageInput): LLMTokenUsage {
  const cacheReadInputTokens = optionalNonNegative(input.cacheReadInputTokens);
  const cacheWriteInputTokens = optionalNonNegative(input.cacheWriteInputTokens);
  return {
    inputTokens: nonNegative(input.inputTokens),
    outputTokens: nonNegative(input.outputTokens),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}

/**
 * 返回当前已知累计用量, 以及相对上次记录新增的用量.
 * 供应商重复或回退计数时保留已记录的最大值, 避免重复累计或出现负增量.
 */
export function updateLLMCallUsage(
  current: LLMTokenUsage,
  reported: LLMTokenUsage,
): { usage: LLMTokenUsage; delta: LLMTokenUsage } {
  const inputTokens = Math.max(
    nonNegative(current.inputTokens),
    nonNegative(reported.inputTokens),
  );
  const outputTokens = Math.max(
    nonNegative(current.outputTokens),
    nonNegative(reported.outputTokens),
  );
  const cacheReadInputTokens = maxOptional(
    current.cacheReadInputTokens,
    reported.cacheReadInputTokens,
  );
  const cacheWriteInputTokens = maxOptional(
    current.cacheWriteInputTokens,
    reported.cacheWriteInputTokens,
  );

  return {
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    },
    delta: {
      inputTokens: inputTokens - nonNegative(current.inputTokens),
      outputTokens: outputTokens - nonNegative(current.outputTokens),
      ...(cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: cacheReadInputTokens - nonNegative(current.cacheReadInputTokens ?? 0) }
        : {}),
      ...(cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: cacheWriteInputTokens - nonNegative(current.cacheWriteInputTokens ?? 0) }
        : {}),
    },
  };
}

export function hasLLMTokenUsage(usage: LLMTokenUsage): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || (usage.cacheReadInputTokens ?? 0) > 0
    || (usage.cacheWriteInputTokens ?? 0) > 0;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function optionalNonNegative(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : nonNegative(value);
}

function maxOptional(
  current: number | undefined,
  reported: number | undefined,
): number | undefined {
  if (current === undefined && reported === undefined) return undefined;
  return Math.max(nonNegative(current ?? 0), nonNegative(reported ?? 0));
}
