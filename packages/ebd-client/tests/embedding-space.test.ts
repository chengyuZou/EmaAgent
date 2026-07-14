import { describe, expect, it } from 'vitest';
import { createEmbeddingSpace } from '../src/embedding-space.js';

describe('EmbeddingSpace identity', () => {
  it('相同输入跨调用生成相同空间 ID', () => {
    const input = {
      providerId: 'provider-a',
      model: 'bge-m3',
      dim: 1024,
      normalization: 'l2' as const,
      revision: 'provider-managed',
    };
    expect(createEmbeddingSpace(input)).toEqual(createEmbeddingSpace(input));
    expect(createEmbeddingSpace(input).id).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['model', { model: 'other-model' }],
    ['dim', { dim: 768 }],
    ['revision', { revision: '2026-07-14' }],
  ])('%s 改变时生成不同空间 ID', (_field, change) => {
    const base = createEmbeddingSpace({
      providerId: 'provider-a', model: 'bge-m3', dim: 1024, revision: 'provider-managed',
    });
    const changed = createEmbeddingSpace({
      providerId: 'provider-a', model: 'bge-m3', dim: 1024, revision: 'provider-managed',
      ...change,
    });
    expect(changed.id).not.toBe(base.id);
  });
});
