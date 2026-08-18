// 粗筛后的 LLM 语义精选：判断哪些召回候选与当前查询真正相关。
import type { LanguageModel, AssistantBlock } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';
import type { RecalledNode, RecalledItem } from '../types.js';

export interface RecallSelection {
  nodeIds: string[];
  itemIds: string[];
}

const MAX_CANDIDATES_PER_KIND = 12;

/**
 * embedding/启发式粗筛只负责把候选缩小；"这条记忆和当前问题是否真的相关"
 * 由 LLM 判断——它能区分字面相近但语义域不同的记忆（"苹果手机"与"苹果"）。
 *
 * 返回 null 表示精选不可用（未配置模型、调用失败、输出无法解析）；
 * 调用方必须回退为粗筛结果——精选是增强，不是门禁。
 */
export async function selectRelevantMemories(args: {
  llm: LanguageModel;
  modelBindings: ModelBindingsRepo;
  userInput: string;
  nodes: readonly RecalledNode[];
  items: readonly RecalledItem[];
  now?: number;
  signal?: AbortSignal;
}): Promise<RecallSelection | null> {
  if (args.nodes.length === 0 && args.items.length === 0) return null;
  const binding = args.modelBindings.get('memory-llm');
  if (!binding) return null;

  const nodes = args.nodes.slice(0, MAX_CANDIDATES_PER_KIND);
  const items = args.items.slice(0, MAX_CANDIDATES_PER_KIND);
  const now = args.now ?? Date.now();

  const nodeLines = nodes.map((n, i) =>
    `N${i + 1}. (${n.nodeType}) ${n.label}: ${n.description}`,
  );
  const itemLines = items.map((item, i) =>
    `M${i + 1}. [${item.kind}] (${memoryAge(item.updatedAt, now)}) ${item.title}: ${item.body}`,
  );

  const prompt = [
    '下面是一位用户刚刚说的话，以及从长期记忆中粗筛出的候选条目。',
    '只保留与这句话真正相关、有助于回应的条目；宁可少选也不要带上无关条目。',
    '注意区分字面相近但语义域不同的条目（例如"苹果手机"与"苹果（水果）"）。',
    '只输出 JSON：{"relevant_nodes": ["N1", "N3"], "relevant_items": ["M2"]}；都不相关则输出空数组。',
    '',
    `用户的话：${args.userInput}`,
    '',
    '候选实体：',
    nodeLines.length > 0 ? nodeLines.join('\n') : '(无)',
    '',
    '候选记忆条目：',
    itemLines.length > 0 ? itemLines.join('\n') : '(无)',
  ].join('\n');

  try {
    const completion = await args.llm.complete({
      providerId: binding.providerConfigId,
      model: binding.model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 256,
      temperature: 0,
      signal: args.signal,
    });
    const text = completion.blocks
      .filter((b: AssistantBlock): b is AssistantBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseSelection(text, nodes, items);
  } catch {
    return null;
  }
}

function parseSelection(
  text: string,
  nodes: readonly RecalledNode[],
  items: readonly RecalledItem[],
): RecallSelection | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const nodeIds = resolveRefs(parsed['relevant_nodes'], 'N', nodes.map(n => n.id));
    const itemIds = resolveRefs(parsed['relevant_items'], 'M', items.map(i => i.id));
    if (!nodeIds || !itemIds) return null;
    return { nodeIds, itemIds };
  } catch {
    return null;
  }
}

/** 把 ["N1","N3"] 形式的引用解析为真实 id；引用越界或不是数组时返回 null。 */
function resolveRefs(value: unknown, prefix: string, ids: string[]): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const ref of value) {
    if (typeof ref !== 'string') return null;
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(ref.trim());
    if (!match) return null;
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= ids.length) return null;
    out.push(ids[index]!);
  }
  return out;
}

function memoryAge(ms: number, now: number): string {
  const days = Math.max(0, Math.floor((now - ms) / 86_400_000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}
