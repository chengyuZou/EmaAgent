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
  encode(value) {
    return value;
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
