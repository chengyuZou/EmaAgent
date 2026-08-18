// 测试检索结果预算填充与 kb.retrieval 设置解码。

import { describe, expect, it } from 'vitest';
import { applyResultBudget } from '../retrieval/resultBudget.js';
import {
  kbAlphaSetting,
  kbDefaultTopKSetting,
  kbRerankBlendWeightSetting,
  kbResultMaxCharsSetting,
} from '../settings.js';
import type { KbSearchHit } from '../types.js';

function hit(id: string, text: string, score: number): KbSearchHit {
  return {
    chunkId: id,
    text,
    score,
    source: {
      assetId: `asset-${id}`,
      fileName: `${id}.txt`,
      sectionPath: [],
      chunkPreview: text.slice(0, 200),
    },
  };
}

describe('applyResultBudget', () => {
  it('未提供预算时原样返回', () => {
    const hits = [hit('a', 'x'.repeat(100), 0.9), hit('b', 'y'.repeat(100), 0.8)];
    expect(applyResultBudget(hits, undefined)).toEqual(hits);
    expect(applyResultBudget(hits, 0)).toEqual(hits);
  });

  it('预算充足时全部保留全文', () => {
    const hits = [hit('a', 'x'.repeat(100), 0.9), hit('b', 'y'.repeat(100), 0.8)];
    const out = applyResultBudget(hits, 200);
    expect(out.map(h => h.citationOnly)).toEqual([undefined, undefined]);
    expect(out[0]!.text).toHaveLength(100);
  });

  it('第一个放不下的命中起全部降级为引用卡', () => {
    const hits = [
      hit('a', 'x'.repeat(100), 0.9),
      hit('b', 'y'.repeat(100), 0.8),
      hit('c', 'z'.repeat(100), 0.7),
    ];
    const out = applyResultBudget(hits, 150);
    expect(out).toHaveLength(3);
    expect(out[0]!.citationOnly).toBeUndefined();
    expect(out[0]!.text).toHaveLength(100);
    // b 与 c 降级：text 只剩命中块预览，并显式标记
    expect(out[1]!.citationOnly).toBe(true);
    expect(out[1]!.text.length).toBeLessThanOrEqual(200);
    expect(out[2]!.citationOnly).toBe(true);
    // 出处保留，模型知道内容在哪
    expect(out[2]!.source.fileName).toBe('c.txt');
  });

  it('已经是 citation-only 的命中不重复降级', () => {
    const original = hit('a', 'preview', 0.5);
    original.citationOnly = true;
    const out = applyResultBudget([original], 1);
    expect(out[0]).toBe(original);
  });
});

describe('kb.retrieval 设置校验', () => {
  it('合法值通过', () => {
    expect(kbDefaultTopKSetting.schema.safeParse(5).success).toBe(true);
    expect(kbAlphaSetting.schema.safeParse(0.8).success).toBe(true);
    expect(kbRerankBlendWeightSetting.schema.safeParse(0.6).success).toBe(true);
    expect(kbResultMaxCharsSetting.schema.safeParse(12_000).success).toBe(true);
  });

  it('越界值拒绝', () => {
    expect(kbDefaultTopKSetting.schema.safeParse(0).success).toBe(false);
    expect(kbDefaultTopKSetting.schema.safeParse(21).success).toBe(false);
    expect(kbAlphaSetting.schema.safeParse(1.5).success).toBe(false);
    expect(kbRerankBlendWeightSetting.schema.safeParse(-0.1).success).toBe(false);
    expect(kbResultMaxCharsSetting.schema.safeParse(500).success).toBe(false);
    expect(kbResultMaxCharsSetting.schema.safeParse('nonsense').success).toBe(false);
  });
});
