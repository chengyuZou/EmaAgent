import type { EmbedProtocol } from '@ema-agent/providers';

export type { EmbedProtocol } from '@ema-agent/providers';

export interface EmbeddingConnection {
  readonly protocol: EmbedProtocol;
  /** 本地服务或网关可以不需要凭据. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
}

/** 模型和协议在 createEmbedCall 时选定, 每次调用提交一批文本. */
export type CallEmbed = (request: EmbeddingRequest) => Promise<EmbeddingResult>;

/** 供应商报告的输入 Token 数量. 当前 Gemini 实现不返回此项. */
export interface EmbeddingUsage {
  readonly inputTokens: number;
}

export interface EmbeddingResult {
  /** 顺序与 texts 一致. 范数为有限非零值时做 L2 归一化, 其余向量保持原值. */
  readonly embeddings: readonly (readonly number[])[];
  /** 空批次为 0, 非空结果中的每个向量都使用此维度. */
  readonly dim: number;
  readonly usage?: EmbeddingUsage;
}

/** 协议原始结果, 由公共入口校验数量和维度后归一化. */
export interface RawEmbeddingResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dim: number;
  readonly usage?: EmbeddingUsage;
}
