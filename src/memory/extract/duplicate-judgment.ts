// 用 LLM 判定两个记忆节点是否描述同一实体，替代纯 embedding 相似度归并。
import type { LanguageModel, AssistantBlock } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';

export interface DuplicateJudgmentInput {
  candidateLabel: string;
  candidateDescription: string;
  existingLabel: string;
  existingDescription: string;
}

/**
 * 返回 true=同一实体（可归并）、false=不同实体、null=判定不可用。
 * 判定失败时调用方必须保守新建——不确定不是合并的理由，
 * 误并造成的语义污染比误拆多一个节点严重得多。
 */
export async function judgeDuplicateEntity(
  llm: LanguageModel,
  modelBindings: ModelBindingsRepo,
  input: DuplicateJudgmentInput,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const binding = modelBindings.get('memory');
  if (!binding) return null;

  const prompt = [
    '判断下面两条记忆是否描述同一个实体（同一个人/宠物/物品/概念）。',
    '字面相近但语义域不同的不算同一实体（例如"苹果手机"与"苹果（水果）"）。',
    '只输出 JSON：{"same": true} 或 {"same": false}。',
    '',
    `新提取：${input.candidateLabel} — ${input.candidateDescription}`,
    `既有记忆：${input.existingLabel} — ${input.existingDescription}`,
  ].join('\n');

  try {
    const completion = await llm.complete({
      providerId: binding.providerConfigId,
      model: binding.model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 64,
      temperature: 0,
      signal,
    });
    const text = completion.blocks
      .filter((b: AssistantBlock): b is AssistantBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseSameVerdict(text);
  } catch {
    return null;
  }
}

function parseSameVerdict(text: string): boolean | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return typeof parsed['same'] === 'boolean' ? parsed['same'] : null;
  } catch {
    return null;
  }
}
