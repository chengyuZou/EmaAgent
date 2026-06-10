import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbedAdapter } from '../src/adapters/gemini-embed.js';
import { CohereRerankAdapter } from '../src/adapters/cohere-rerank.js';
import type { EmbedProviderConfig, RerankProviderConfig } from '../src/types.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function geminiConfig(overrides: Partial<EmbedProviderConfig> = {}): EmbedProviderConfig {
  return {
    id:       'gemini-embed-test',
    protocol: 'gemini-embed',
    apiKey:   'test-gemini-key',
    baseUrl:  'https://generativelanguage.googleapis.com/v1beta',
    dim:      768,
    ...overrides,
  };
}

function rerankConfig(overrides: Partial<RerankProviderConfig> = {}): RerankProviderConfig {
  return {
    id:       'rerank-test',
    protocol: 'cohere-rerank',
    apiKey:   'test-rerank-key',
    baseUrl:  'https://api.example.test/v1',
    ...overrides,
  };
}

function firstFetchCall(): [input: RequestInfo | URL, init?: RequestInit] {
  const call = fetchMock.mock.calls[0];
  expect(call).toBeDefined();
  return call as [RequestInfo | URL, RequestInit | undefined];
}

describe('GeminiEmbedAdapter', () => {
  it('sends the API key in x-goog-api-key instead of the URL query string', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    const adapter = new GeminiEmbedAdapter(geminiConfig());

    const result = await adapter.embed(['hello'], 'text-embedding-004');

    const [input, init] = firstFetchCall();
    expect(String(input)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents',
    );
    expect(String(input)).not.toContain('key=');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-gemini-key');
    expect(result).toEqual({ embeddings: [[0.1, 0.2, 0.3]], dim: 3 });
  });
});

describe('CohereRerankAdapter', () => {
  it('throws a clear error when baseUrl is missing', async () => {
    const adapter = new CohereRerankAdapter(rerankConfig({ baseUrl: undefined }));

    await expect(adapter.rerank('query', ['doc'], 1, 'rerank-model'))
      .rejects.toThrow('baseUrl is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to an absolute /rerank URL and trims trailing slashes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    }), { status: 200 }));
    const adapter = new CohereRerankAdapter(rerankConfig({
      baseUrl: 'https://api.example.test/v1///',
    }));

    const result = await adapter.rerank('query', ['a', 'b'], 2, 'rerank-model');

    const [input, init] = firstFetchCall();
    expect(String(input)).toBe('https://api.example.test/v1/rerank');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-rerank-key');
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'rerank-model',
      query: 'query',
      documents: ['a', 'b'],
      top_n: 2,
    });
    expect(result).toEqual({
      results: [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.2 },
      ],
    });
  });
});
