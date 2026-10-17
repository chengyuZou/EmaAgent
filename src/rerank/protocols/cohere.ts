import { RerankError } from '../errors.js';
import type { RerankConnection, RerankRequest, RerankResult } from '../types.js';

export function createCohereRerankProtocol(
  connection: RerankConnection,
  modelId: string,
): (request: RerankRequest & { readonly topK: number }) => Promise<RerankResult> {
  const baseUrl = (connection.baseUrl ?? 'https://api.cohere.com/v2').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (connection.apiKey) headers['Authorization'] = `Bearer ${connection.apiKey}`;

  return async (request) => {
    const response = await fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        query: request.query,
        documents: request.documents,
        top_n: request.topK,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const excerpt = (await response.text().catch(() => '')).slice(0, 500);
      throw new RerankError(
        'rerank/http_error',
        `cohere-rerank returned HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
        response.status,
      );
    }

    const body = await readJson(response) as {
      results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      usage?: { total_tokens?: number };
      meta?: { tokens?: { input_tokens?: number; output_tokens?: number } };
    };
    if (!Array.isArray(body.results)) {
      throw new RerankError('rerank/invalid_response', 'cohere-rerank response is missing results');
    }
    // 部分兼容接口只报告 total_tokens. search_units 是计费次数, 不能记成 Token.
    const inputTokens = body.meta?.tokens?.input_tokens ?? body.usage?.total_tokens;
    const outputTokens = body.meta?.tokens?.output_tokens;
    for (const tokens of [inputTokens, outputTokens]) {
      if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) {
        throw new RerankError('rerank/invalid_response', 'cohere-rerank returned invalid token usage');
      }
    }
    return {
      ...(inputTokens !== undefined ? {
        usage: {
          inputTokens,
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        },
      } : {}),
      results: body.results.map((item) => {
        const score = item.relevance_score ?? item.score;
        if (typeof item.index !== 'number' || typeof score !== 'number') {
          throw new RerankError(
            'rerank/invalid_response',
            'cohere-rerank result is missing index or score',
          );
        }
        return { index: item.index, score };
      }),
    };
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new RerankError(
      'rerank/invalid_response',
      'cohere-rerank returned invalid JSON',
      response.status,
      error,
    );
  }
}
