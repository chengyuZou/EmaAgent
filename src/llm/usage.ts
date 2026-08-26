// 归一化 Provider 用量，并把同一次物理调用的累计快照转换为聚合增量。

/** Provider 对一次物理 LLM 调用报告的累计 Token；缓存字段是 inputTokens 的子集。 */
export interface LlmTokenUsage {
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

export function createLlmTokenUsage(input: ProviderUsageInput): LlmTokenUsage {
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
 * Provider Usage 是累计快照。返回本次调用当前已知用量和相对上一快照的新增量；
 * Provider 偶发回退计数时保留已确认上界，不产生负增量。
 */
export function updateLlmCallUsage(
  current: LlmTokenUsage,
  reported: LlmTokenUsage,
): { usage: LlmTokenUsage; delta: LlmTokenUsage } {
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

export function hasLlmTokenUsage(usage: LlmTokenUsage): boolean {
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
