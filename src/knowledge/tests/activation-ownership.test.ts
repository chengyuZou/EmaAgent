// 测试 KB activation 只接受当前知识库拥有的文档，并且无效显式范围不会退化成全库搜索。
import { describe, expect, it, vi } from 'vitest';
import type {
  DocumentAssetRepo,
  DocumentChunkRepo,
  DocumentPreviewRepo,
  KbActivationsRepo,
} from '@ema-agent/storage';
import { KnowledgeStore } from '../store/store.js';
import { KnowledgeClient } from '../client.js';

describe('KB activation 资产归属', () => {
  it('只更新和记录当前 KB 中真实存在的 asset ID', () => {
    const recordActivation = vi.fn();
    const recordCall = vi.fn();
    const assets = {
      findExistingIds: (ids: readonly string[]) => ids.filter((id) => id === 'owned'),
      recordActivation,
    } as unknown as DocumentAssetRepo;
    const activations = { recordCall } as unknown as KbActivationsRepo;
    const store = new KnowledgeStore(
      assets,
      {} as DocumentChunkRepo,
      {} as DocumentPreviewRepo,
      activations,
      'kb-1',
    );

    const ownedAssetIds = store.recordActivation(['foreign', 'owned', 'owned'], {
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 123,
    });

    expect(ownedAssetIds).toEqual(['owned']);
    expect(recordActivation).toHaveBeenCalledWith(['owned'], 123);
    expect(recordCall).toHaveBeenCalledWith({
      kbId: 'kb-1',
      assetIds: ['owned'],
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 123,
    });
  });

  it('显式范围全部不属于当前 KB 时直接返回空结果', async () => {
    const searchFts = vi.fn();
    const store = {
      filterExistingAssetIds: vi.fn(() => []),
      searchFts,
    } as unknown as KnowledgeStore;
    const client = new KnowledgeClient({
      store,
      resolveEmbedding: () => undefined,
      resolveReranker: () => undefined,
      resolveVision: () => undefined,
    });

    await expect(client.search('query', { assetIds: ['foreign'] })).resolves.toEqual({
      query: 'query',
      hits: [],
    });
    expect(searchFts).not.toHaveBeenCalled();
  });
});
