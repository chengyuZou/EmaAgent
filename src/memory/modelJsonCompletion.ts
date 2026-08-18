// 调用 Memory 绑定的模型并提取单个 JSON 对象，供提取与归并流水线复用。

import type { AssistantBlock, LanguageModel } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';

export async function runMemoryJsonCompletion(
  llm: LanguageModel,
  modelBindings: ModelBindingsRepo,
  prompt: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  const binding = modelBindings.get('memory-llm');
  if (!binding) return null;

  const completion = await llm.complete({
    providerId: binding.providerConfigId,
    model: binding.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 2500,
    temperature: 0.2,
    signal,
  });
  const text = completion.blocks
    .filter(
      (block: AssistantBlock): block is AssistantBlock & { type: 'text' } =>
        block.type === 'text',
    )
    .map(block => block.text)
    .join('');

  const stripped = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('memory: no JSON object found in LLM output');
  }
  return JSON.parse(stripped.slice(start, end + 1));
}
