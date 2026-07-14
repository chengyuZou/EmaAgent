import { createHash } from 'node:crypto';

export type EmbeddingNormalization = 'l2';

export interface EmbeddingSpace {
  /** 向量空间的稳定内容身份，不包含 API Key、Base URL 等秘密或部署细节。 */
  id: string;
  providerId: string;
  model: string;
  dim: number;
  normalization: EmbeddingNormalization;
  revision: string;
}

export interface EmbeddingSpaceInput {
  providerId: string;
  model: string;
  dim: number;
  normalization?: EmbeddingNormalization;
  revision?: string;
}

/**
 * 生成跨平台稳定的向量空间身份。
 * 字段按固定数组序列化，避免对象属性顺序或平台换行影响 hash。
 */
export function createEmbeddingSpace(input: EmbeddingSpaceInput): EmbeddingSpace {
  const providerId = requiredText('providerId', input.providerId);
  const model = requiredText('model', input.model);
  if (!Number.isSafeInteger(input.dim) || input.dim <= 0) {
    throw new RangeError(`Embedding dimension must be a positive safe integer, got ${input.dim}`);
  }
  const normalization = input.normalization ?? 'l2';
  const revision = requiredText('revision', input.revision ?? 'provider-managed');
  const canonical = JSON.stringify([
    'ema-embedding-space-v1',
    providerId,
    model,
    input.dim,
    normalization,
    revision,
  ]);
  return {
    id: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    providerId,
    model,
    dim: input.dim,
    normalization,
    revision,
  };
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must not be empty`);
  return normalized;
}
