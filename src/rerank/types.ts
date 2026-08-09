import type { RerankProtocol } from '@ema-agent/provider';

export type { RerankProtocol } from '@ema-agent/provider';

/** Provider 已解析好的 Rerank 协议连接。 */
export interface RerankConnection {
  readonly protocol: RerankProtocol;
  /** 本地或受信网关可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 单次 Rerank 请求；模型返回的 index 对应 documents 的原始下标。 */
export interface RerankRequest {
  readonly model: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topK?: number;
  readonly signal?: AbortSignal;
}

export interface RerankItem {
  readonly index: number;
  /** Provider 原始相关度分数，不做跨批次伪归一化。 */
  readonly score: number;
}

export interface RerankResult {
  readonly results: readonly RerankItem[];
}
