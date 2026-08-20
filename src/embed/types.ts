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

/** Provider 报告的嵌入用量；不是所有协议都返回（Gemini 无 usage）。 */
export interface EmbeddingUsage {
  readonly inputTokens: number;
}

/** 向量已执行 L2 归一化，顺序与请求 texts 严格一致。 */
export interface EmbeddingResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dim: number;
  readonly usage?: EmbeddingUsage;
}

/** 协议实现返回的未校验向量，不从包入口导出。 */
export interface RawEmbeddingResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dim: number;
  readonly usage?: EmbeddingUsage;
}
