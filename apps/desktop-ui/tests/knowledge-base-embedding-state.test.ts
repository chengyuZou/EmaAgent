// 测试知识库文档按完整 Embedding 空间身份判断是否需要重嵌。
import { describe, expect, it } from 'vitest';
import type { DocumentAssetWire } from '../src/api/knowledge-base.js';
import type { AvailableBindingModel } from '../src/api/model-bindings.js';
import {
  documentNeedsReembed,
  resolveEmbedSelection,
  sameKbModelRef,
} from '../src/settings/knowledge/knowledge-base-embedding-state.js';

const model: AvailableBindingModel = {
  providerConfigId: 'provider-a',
  providerName: 'Provider A',
  model: 'bge-m3',
  contextWindow: 0,
  dim: 1024,
  embeddingSpace: {
    id: 'space-a-v1',
    providerId: 'provider-a',
    model: 'bge-m3',
    dim: 1024,
    normalization: 'l2',
    revision: 'provider-managed',
  },
};

function document(overrides: Partial<DocumentAssetWire> = {}): DocumentAssetWire {
  return {
    id: 'doc-1',
    filePath: 'D:/kb/doc.txt',
    fileName: 'doc.txt',
    mimeType: 'text/plain',
    wordCount: 10,
    status: 'indexed',
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
    ebdModel: 'bge-m3',
    ebdProviderId: 'provider-a',
    ebdDim: 1024,
    ebdNormalization: 'l2',
    ebdRevision: 'provider-managed',
    ebdSpaceId: 'space-a-v1',
    ...overrides,
  };
}

describe('知识库 Embedding 空间状态', () => {
  const selection = resolveEmbedSelection([model], {
    providerConfigId: 'provider-a',
    model: 'bge-m3',
  });

  it('Provider 与模型必须共同匹配', () => {
    expect(sameKbModelRef(
      { providerConfigId: 'provider-a', model: 'bge-m3' },
      { providerConfigId: 'provider-b', model: 'bge-m3' },
    )).toBe(false);
  });

  it('完整 spaceId 相同才视为当前向量空间', () => {
    expect(documentNeedsReembed(document(), selection)).toBe(false);
    expect(documentNeedsReembed(document({ ebdSpaceId: 'space-a-v2' }), selection)).toBe(true);
  });

  it('同名模型但 Provider 不同必须重嵌', () => {
    expect(documentNeedsReembed(document({
      ebdSpaceId: undefined,
      ebdProviderId: 'provider-b',
    }), selection)).toBe(true);
  });

  it('旧文档缺少完整身份或从未嵌入时采取保守重建', () => {
    expect(documentNeedsReembed(document({ ebdSpaceId: undefined, ebdRevision: undefined }), selection)).toBe(true);
    expect(documentNeedsReembed(document({ ebdModel: undefined, ebdSpaceId: undefined }), selection)).toBe(true);
  });

  it('没有配置 Embedding 模型时不要求重嵌', () => {
    expect(documentNeedsReembed(document({ ebdStale: true }), undefined)).toBe(false);
  });
});
