// 创建一个绑定协议连接的 Embedding 模型，并统一校验和归一化外部向量。
import { EmbeddingError } from './errors.js';
import { createGeminiEmbeddingProtocol } from './protocols/gemini.js';
import { createOpenAiEmbeddingProtocol } from './protocols/openAi.js';
import type {
  EmbeddingConnection,
  EmbeddingRequest,
  EmbeddingResult,
  RawEmbeddingResult,
} from './types.js';

export interface EmbeddingModel {
  readonly protocol: EmbeddingConnection['protocol'];
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

/**
 * Embedding 唯一创建入口。连接在创建时绑定；每次请求只携带模型、文本和取消信号。
 */
export function createEmbeddingModel(connection: EmbeddingConnection): EmbeddingModel {
  const protocolEmbed = createProtocolEmbed(connection);
  return {
    protocol: connection.protocol,
    async embed(request) {
      validateRequest(request);
      if (request.texts.length === 0) return { embeddings: [], dim: 0 };
      const raw = await protocolEmbed(request);
      validateResponse(request.texts.length, raw);
      return {
        embeddings: raw.embeddings.map(normalizeEmbedding),
        dim: raw.dim,
        ...(raw.usage ? { usage: raw.usage } : {}),
      };
    },
  };
}

function createProtocolEmbed(
  connection: EmbeddingConnection,
): (request: EmbeddingRequest) => Promise<RawEmbeddingResult> {
  switch (connection.protocol) {
    case 'openai-embed': return createOpenAiEmbeddingProtocol(connection);
    case 'gemini-embed': return createGeminiEmbeddingProtocol(connection);
  }
}

function validateRequest(request: EmbeddingRequest): void {
  if (!request.model.trim()) {
    throw new EmbeddingError('embed/invalid_request', 'Embedding model must not be empty');
  }
  if (request.texts.some((text) => text.length === 0)) {
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
