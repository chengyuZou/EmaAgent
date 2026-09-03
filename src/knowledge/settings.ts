// Knowledge Base 的检索参数设置(模型选择已迁出到 model_bindings)。
// Embed/Rerank 模型选择(kb-embed/kb-rerank)由装配层从 model_bindings 读取并
// 解析成 Call 闭包注入,不再存 settings;这里只留标量检索参数。
// 设置接口与字段统一在此文件,拆细为一字段一 key。

import type { SettingsStore } from '@ema-agent/settings';
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

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

export const kbDefaultTopKSetting = defineSetting({
  key: 'kb.retrieval.defaultTopK',
  apply: 'nextOperation',
  defaultValue: 5,
  schema: z.number().int().min(1).max(20),
});

export const kbAlphaSetting = defineSetting({
  key: 'kb.retrieval.alpha',
  apply: 'nextOperation',
  defaultValue: 0.5,
  schema: z.number().min(0).max(1),
});

export const kbRerankBlendWeightSetting = defineSetting({
  key: 'kb.retrieval.rerankBlendWeight',
  apply: 'nextOperation',
  defaultValue: 0.6,
  schema: z.number().min(0).max(1),
});

export const kbResultMaxCharsSetting = defineSetting({
  key: 'kb.retrieval.resultMaxChars',
  apply: 'nextOperation',
  defaultValue: 12_000,
  schema: z.number().int().min(1_000).max(50_000),
});

/** 整组默认快照(供消费方默认参数与测试),单一事实源是各 setting 的 defaultValue。 */
export const DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS: KnowledgeRetrievalSettings = {
  defaultTopK: kbDefaultTopKSetting.defaultValue,
  alpha: kbAlphaSetting.defaultValue,
  rerankBlendWeight: kbRerankBlendWeightSetting.defaultValue,
  resultMaxChars: kbResultMaxCharsSetting.defaultValue,
};

/** 聚合读取检索参数快照(坏值/缺失自动回落默认)。 */
export function readKnowledgeRetrievalSettings(
  store: SettingsStore,
): KnowledgeRetrievalSettings {
  return {
    defaultTopK: store.get(kbDefaultTopKSetting),
    alpha: store.get(kbAlphaSetting),
    rerankBlendWeight: store.get(kbRerankBlendWeightSetting),
    resultMaxChars: store.get(kbResultMaxCharsSetting),
  };
}
