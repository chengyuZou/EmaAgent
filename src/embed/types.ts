import type { EmbedProtocol } from '@ema-agent/providers';

export type { EmbedProtocol } from '@ema-agent/providers';

/** Provider 已解析好的 Embedding 协议连接。 */
export interface EmbeddingConnection {
  readonly protocol: EmbedProtocol;
  /** 本地或受信网关可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 单次 Embedding 请求；路由身份、重试和 Usage 归上层。 */
export interface EmbeddingRequest {
  readonly model: string;
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
}

/** 向量已执行 L2 归一化，顺序与请求 texts 严格一致。 */
export interface EmbeddingResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dim: number;
}

/** 协议实现返回的未校验向量，不从包入口导出。 */
export interface RawEmbeddingResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dim: number;
}
