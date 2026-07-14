import { afterEach, describe, expect, it, vi } from 'vitest';
import { EbdRouter } from '../src/router.js';

afterEach(() => vi.unstubAllGlobals());

describe('EbdRouter embedding space', () => {
  it('统一 L2 归一化并在响应中携带完整空间身份', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [3, 4] }] }), { status: 200 }),
    ));
    const router = new EbdRouter([{
      id: 'provider-a',
      protocol: 'openai-embed',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      embeddingRevision: '2026-07',
    }]);

    const result = await router.embed({
      providerId: 'provider-a',
      model: 'embed-v1',
      texts: ['hello'],
    });

    expect(result.embeddings[0]).toEqual([0.6, 0.8]);
    expect(result.space).toMatchObject({
      providerId: 'provider-a',
      model: 'embed-v1',
      dim: 2,
      normalization: 'l2',
      revision: '2026-07',
    });
    expect(router.embeddingSpace('provider-a', 'embed-v1', 2).id).toBe(result.space.id);
  });
});
