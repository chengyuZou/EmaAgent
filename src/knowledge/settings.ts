// 定义 Knowledge Base 使用的 Embed 与 Rerank 模型选择。

import { defineSetting } from '@ema-agent/settings';

export interface KnowledgeModelRef {
  providerConfigId: string;
  model: string;
}

export interface KnowledgeModelSettings {
  embed?: KnowledgeModelRef;
  rerank?: KnowledgeModelRef;
}

export const knowledgeModelsSetting = defineSetting<KnowledgeModelSettings>({
  key: 'kb.models',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: {},
  decode(value: unknown) {
    if (!isRecord(value)) return { ok: false };
    const embed = decodeModelRef(value['embed']);
    const rerank = decodeModelRef(value['rerank']);
    if (embed === null || rerank === null) return { ok: false };
    return {
      ok: true,
      value: {
        ...(embed ? { embed } : {}),
        ...(rerank ? { rerank } : {}),
      },
    };
  },
});

function decodeModelRef(value: unknown): KnowledgeModelRef | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return null;
  const providerConfigId = value['providerConfigId'];
  const model = value['model'];
  if (typeof providerConfigId !== 'string' || providerConfigId.length === 0) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  return { providerConfigId, model };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── 检索参数 ──────────────────────────────────────────────────────────────────

/** 每次检索操作时读取的用户可调参数；显式传入调用选项时以调用方为准。 */
export interface KnowledgeRetrievalSettings {
  /** 调用方未指定 topK 时的默认命中数。 */
  defaultTopK: number;
  /** RRF 融合中稠密（向量）路权重；1-alpha 为稀疏（BM25）路权重。 */
  alpha: number;
  /** 混合排序中 rerank 分的权重；1-权重为 RRF 分权重。 */
  rerankBlendWeight: number;
  /** 模型工具检索结果的正文总字符预算；HTTP 面板不受此限。 */
  resultMaxChars: number;
}

export const DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS: KnowledgeRetrievalSettings = {
  defaultTopK: 5,
  alpha: 0.5,
  rerankBlendWeight: 0.6,
  resultMaxChars: 12_000,
};

export const knowledgeRetrievalSetting = defineSetting<KnowledgeRetrievalSettings>({
  key: 'kb.retrieval',
  kind: 'object',
  apply: 'nextOperation',
  defaultValue: DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
  decode(value) {
    if (!isRecord(value)) return { ok: false };
    const merged = { ...DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS, ...value };
    if (!integerInRange(merged.defaultTopK, 1, 20)) return { ok: false };
    if (!ratioInRange(merged.alpha)) return { ok: false };
    if (!ratioInRange(merged.rerankBlendWeight)) return { ok: false };
    if (!integerInRange(merged.resultMaxChars, 1_000, 50_000)) return { ok: false };
    return { ok: true, value: merged as KnowledgeRetrievalSettings };
  },
});

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function ratioInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
