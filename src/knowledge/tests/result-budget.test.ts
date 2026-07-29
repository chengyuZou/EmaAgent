// 测试检索结果预算填充、kb.retrieval 设置解码与 KbManager 合并后统一填充。

import { describe, expect, it, vi } from 'vitest';
import type { KbRegistryRepo, KbActivationsRepo } from '@ema-agent/storage';
import { applyResultBudget } from '../retrieval/resultBudget.js';
import {
  DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
  knowledgeRetrievalSetting,
} from '../settings.js';
import { KbManager, type KbEntry } from '../manager.js';
import type { KbSearchHit, KbSearchResult, SearchOptions } from '../types.js';

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

describe('knowledgeRetrievalSetting 解码', () => {
  it('部分字段按默认值合并', () => {
    const decoded = knowledgeRetrievalSetting.decode({ alpha: 0.8 });
    expect(decoded).toEqual({
      ok: true,
      value: { ...DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS, alpha: 0.8 },
    });
  });

  it('越界值拒绝', () => {
    expect(knowledgeRetrievalSetting.decode({ defaultTopK: 0 }).ok).toBe(false);
    expect(knowledgeRetrievalSetting.decode({ defaultTopK: 21 }).ok).toBe(false);
    expect(knowledgeRetrievalSetting.decode({ alpha: 1.5 }).ok).toBe(false);
    expect(knowledgeRetrievalSetting.decode({ rerankBlendWeight: -0.1 }).ok).toBe(false);
    expect(knowledgeRetrievalSetting.decode({ resultMaxChars: 500 }).ok).toBe(false);
    expect(knowledgeRetrievalSetting.decode('nonsense').ok).toBe(false);
  });
});

describe('KbManager 检索设置接线', () => {
  function createManager(options: {
    hits: KbSearchHit[];
    capturedOpts?: SearchOptions[];
    retrieval?: Partial<typeof DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS>;
  }) {
    const capturedOpts: SearchOptions[] = options.capturedOpts ?? [];
    const fakeClient = {
      search: vi.fn(async (query: string, opts: SearchOptions): Promise<KbSearchResult> => {
        capturedOpts.push(opts);
        return { query, hits: options.hits };
      }),
    };
    const registry = {
      getActive: () => ({ id: 'kb-1', name: 'kb', path: '/tmp/kb-1', isActive: true, createdAt: 0, updatedAt: 0 }),
      get: (id: string) => (id === 'kb-1'
        ? { id: 'kb-1', name: 'kb', path: '/tmp/kb-1', isActive: true, createdAt: 0, updatedAt: 0 }
        : undefined),
    };
    const manager = new KbManager({
      registry: registry as unknown as KbRegistryRepo,
      activations: {} as unknown as KbActivationsRepo,
      resolveIngestOptions: () => ({}),
      resolveRetrievalSettings: () => ({
        ...DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
        ...options.retrieval,
      }),
    });
    // 跳过真实 Database 装配，直接返回假 client。
    (manager as unknown as { openClient: () => Promise<KbEntry> }).openClient =
      async () => ({ client: fakeClient }) as unknown as KbEntry;
    return { manager, fakeClient, capturedOpts };
  }

  it('未显式给定时使用设置里的 alpha/topK 默认值', async () => {
    const { manager, capturedOpts } = createManager({
      hits: [hit('a', 'x', 0.9)],
      retrieval: { defaultTopK: 7, alpha: 0.9 },
    });

    await manager.search([], 'query');

    expect(capturedOpts[0]).toMatchObject({ topK: 7, alpha: 0.9 });
  });

  it('显式 opts 覆盖设置默认值', async () => {
    const { manager, capturedOpts } = createManager({
      hits: [hit('a', 'x', 0.9)],
      retrieval: { defaultTopK: 7, alpha: 0.9 },
    });

    await manager.search([], 'query', { topK: 3, alpha: 0.1 });

    expect(capturedOpts[0]).toMatchObject({ topK: 3, alpha: 0.1 });
  });

  it('maxResultChars 不传给单 KB，合并后统一填充一次', async () => {
    const { manager, capturedOpts } = createManager({
      hits: [
        hit('a', 'x'.repeat(100), 0.9),
        hit('b', 'y'.repeat(100), 0.8),
      ],
    });

    const result = await manager.search([], 'query', { maxResultChars: 150 });

    expect(capturedOpts[0]!.maxResultChars).toBeUndefined();
    expect(result.hits[0]!.citationOnly).toBeUndefined();
    expect(result.hits[1]!.citationOnly).toBe(true);
  });
});
