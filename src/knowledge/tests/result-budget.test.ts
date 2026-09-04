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
    expect(applyResultBudget(hits, undefined)).toEqual({ hits, truncated: false });
    expect(applyResultBudget(hits, 0)).toEqual({ hits, truncated: false });
  });

  it('预算充足时全部保留全文且不截断', () => {
    const hits = [hit('a', 'x'.repeat(100), 0.9), hit('b', 'y'.repeat(100), 0.8)];
    const out = applyResultBudget(hits, 200);
    expect(out.truncated).toBe(false);
    expect(out.hits[0]!.text).toHaveLength(100);
  });

  it('第一个放不下的命中起停止返回并标记截断', () => {
    const hits = [
      hit('a', 'x'.repeat(100), 0.9),
      hit('b', 'y'.repeat(100), 0.8),
      hit('c', 'z'.repeat(100), 0.7),
    ];
    const out = applyResultBudget(hits, 150);
    // a 完整保留; b 起不再返回——不产出正文残缺的结果对象。
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]!.text).toHaveLength(100);
    expect(out.truncated).toBe(true);
  });

  it('预算恰好耗尽且无剩余命中时不标记截断', () => {
    const hits = [hit('a', 'x'.repeat(100), 0.9)];
    const out = applyResultBudget(hits, 100);
    expect(out.hits).toHaveLength(1);
    expect(out.truncated).toBe(false);
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
