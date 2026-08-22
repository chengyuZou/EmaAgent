// 创建点冻结连接与模型身份的 Embedding 调用入口，并统一校验和归一化外部向量。
import { EmbeddingError } from './errors.js';
import { createGeminiEmbeddingProtocol } from './protocols/gemini.js';
import { createOpenAiEmbeddingProtocol } from './protocols/openAi.js';
import type {
  CallEmbed,
  EmbeddingConnection,
  EmbeddingResult,
  RawEmbeddingResult,
} from './types.js';

/**
 * Embedding 唯一创建入口。连接与 modelId 在创建时冻结；
 * 每次调用只携带文本和取消信号。
 */
export function createEmbedCall(connection: EmbeddingConnection, modelId: string): CallEmbed {
  if (!modelId.trim()) throw new EmbeddingError('embed/invalid_request', 'Embedding model must not be empty');
  const protocolEmbed = createProtocolEmbed(connection, modelId);
  return async (request) => {
    validateRequest(request.texts);
    if (request.texts.length === 0) return { embeddings: [], dim: 0 };
    const raw = await protocolEmbed(request);
    validateResponse(request.texts.length, raw);
    return {
      embeddings: raw.embeddings.map(normalizeEmbedding),
      dim: raw.dim,
      ...(raw.usage ? { usage: raw.usage } : {}),
    };
  };
}

function createProtocolEmbed(
  connection: EmbeddingConnection,
  modelId: string,
): CallEmbed {
  switch (connection.protocol) {
    case 'openai-embed': return createOpenAiEmbeddingProtocol(connection, modelId);
    case 'gemini-embed': return createGeminiEmbeddingProtocol(connection, modelId);
  }
}

function validateRequest(texts: readonly string[]): void {
  if (texts.some((text) => text.length === 0)) {
    throw new EmbeddingError('embed/invalid_request', 'Embedding texts must not contain empty items');
  }
}

function validateResponse(expectedCount: number, result: RawEmbeddingResult): void {
  if (!Number.isSafeInteger(result.dim) || result.dim <= 0) {
    throw new EmbeddingError(
      'embed/invalid_response',
      `Embedding provider returned invalid dimension ${result.dim}`,
    );
  }
  if (result.embeddings.length !== expectedCount) {
    throw new EmbeddingError(
      'embed/invalid_response',
      `Embedding provider returned ${result.embeddings.length} vectors for ${expectedCount} texts`,
    );
  }
  for (const vector of result.embeddings) {
    if (vector.length !== result.dim || vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingError(
        'embed/invalid_response',
        `Embedding provider returned malformed vector ${vector.length}/${result.dim}`,
      );
    }
  }
}

function normalizeEmbedding(vector: readonly number[]): number[] {
  let squared = 0;
  for (const value of vector) squared += value * value;
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0) return [...vector];
  return vector.map((value) => value / norm);
}
