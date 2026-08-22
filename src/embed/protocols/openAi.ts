// 把中立 Embedding 请求转换为 OpenAI 兼容的 /embeddings 调用。
import { EmbeddingError } from '../errors.js';
import type {
  EmbeddingConnection,
  EmbeddingRequest,
  RawEmbeddingResult,
} from '../types.js';

export function createOpenAiEmbeddingProtocol(
  connection: EmbeddingConnection, modelId: string,
): (request: EmbeddingRequest) => Promise<RawEmbeddingResult> {
  const baseUrl = (connection.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (connection.apiKey) headers['Authorization'] = `Bearer ${connection.apiKey}`;

  return async (request) => {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        input: request.texts,
        encoding_format: 'float',
      }),
      signal: request.signal,
    });

    if (!response.ok) throw await httpError('openai-embed', response);
    const body = await readJson(response, 'openai-embed') as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      usage?: { prompt_tokens?: number };
    };
    if (!Array.isArray(body.data)) {
      throw new EmbeddingError('embed/invalid_response', 'openai-embed response is missing data');
    }
    const ordered: Array<number[] | undefined> = new Array(request.texts.length);
    for (const item of body.data) {
      if (
        !Number.isSafeInteger(item.index)
        || item.index === undefined
        || item.index < 0
        || item.index >= request.texts.length
        || ordered[item.index] !== undefined
      ) {
        throw new EmbeddingError(
          'embed/invalid_response',
          `openai-embed returned invalid vector index ${item.index}`,
        );
      }
      ordered[item.index] = item.embedding ?? [];
    }
    const embeddings = Array.from({ length: ordered.length }, (_, index) => {
      const vector = ordered[index];
      if (vector === undefined) {
        throw new EmbeddingError(
          'embed/invalid_response',
          `openai-embed response is missing vector index ${index}`,
        );
      }
      return vector;
    });
    const promptTokens = body.usage?.prompt_tokens;
    return {
      embeddings,
      dim: embeddings[0]?.length ?? 0,
      ...(typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens >= 0
        ? { usage: { inputTokens: promptTokens } }
        : {}),
    };
  };
}

async function httpError(protocol: string, response: Response): Promise<EmbeddingError> {
  const excerpt = (await response.text().catch(() => '')).slice(0, 500);
  return new EmbeddingError(
    'embed/http_error',
    `${protocol} returned HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
    response.status,
  );
}

async function readJson(response: Response, protocol: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new EmbeddingError(
      'embed/invalid_response',
      `${protocol} returned invalid JSON`,
      response.status,
      error,
    );
  }
}
