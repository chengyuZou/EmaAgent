// 解析 Memory 归并模型的结构化结果，并限制节点重要度调整范围。

import type { LanguageModel } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';
import { runMemoryJsonCompletion } from '../modelJsonCompletion.js';

export interface ConsolidationModelResult {
  description: string;
  importanceDelta: number;
}

export async function runConsolidationModel(
  llm: LanguageModel,
  modelBindings: ModelBindingsRepo,
  prompt: string,
  signal?: AbortSignal,
): Promise<ConsolidationModelResult | null> {
  const raw = await runMemoryJsonCompletion(llm, modelBindings, prompt, signal);
  if (raw === null) return null;
  const parsed = raw as Record<string, unknown>;
  const description = typeof parsed['updated_description'] === 'string'
    ? parsed['updated_description'].trim()
    : '';
  if (!description) return null;

  const numericDelta = asNumber(parsed['importance_delta']) ?? 0;
  return {
    description,
    importanceDelta: Math.max(-20, Math.min(20, numericDelta)),
  };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
