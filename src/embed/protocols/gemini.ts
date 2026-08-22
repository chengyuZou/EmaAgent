// 把中立 Embedding 请求转换为 Gemini batchEmbedContents 调用。
import { EmbeddingError } from '../errors.js';
import type {
  EmbeddingConnection,
  EmbeddingRequest,
  RawEmbeddingResult,
} from '../types.js';

export function createGeminiEmbeddingProtocol(
  connection: EmbeddingConnection, modelId: string,
): (request: EmbeddingRequest) => Promise<RawEmbeddingResult> {
  const baseUrl = (
    connection.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (connection.apiKey) headers['x-goog-api-key'] = connection.apiKey;

  return async (request) => {
    const response = await fetch(`${baseUrl}/models/${modelId}:batchEmbedContents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requests: request.texts.map((text) => ({
          model: `models/${modelId}`,
          content: { parts: [{ text }] },
        })),
      }),
      signal: request.signal,
    });

    if (!response.ok) throw await httpError(response);
    const body = await readJson(response) as { embeddings?: Array<{ values?: number[] }> };
    if (!Array.isArray(body.embeddings)) {
      throw new EmbeddingError('embed/invalid_response', 'gemini-embed response is missing embeddings');
    }
    const embeddings = body.embeddings.map((item) => item.values ?? []);
    return { embeddings, dim: embeddings[0]?.length ?? 0 };
  };
}

async function httpError(response: Response): Promise<EmbeddingError> {
  const excerpt = (await response.text().catch(() => '')).slice(0, 500);
  return new EmbeddingError(
    'embed/http_error',
    `gemini-embed returned HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
    response.status,
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new EmbeddingError(
      'embed/invalid_response',
      'gemini-embed returned invalid JSON',
      response.status,
      error,
    );
  }
}
