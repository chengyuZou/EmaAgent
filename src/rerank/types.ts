import type { RerankProtocol } from '@ema-agent/providers';

export type { RerankProtocol } from '@ema-agent/providers';

/** Provider 已解析好的 Rerank 协议连接。 */
export interface RerankConnection {
  readonly protocol: RerankProtocol;
  /** 本地或受信网关可以不需要凭据。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 单次 Rerank 请求；模型身份在创建点冻结，模型返回的 index 对应 documents 的原始下标。 */
export interface RerankRequest {
  readonly query: string;
  readonly documents: readonly string[];
  readonly topK?: number;
  readonly signal?: AbortSignal;
}

/** 创建点冻结连接与模型身份的单次 rerank 调用。 */
export type CallRerank = (request: RerankRequest) => Promise<RerankResult>;

export interface RerankItem {
  readonly index: number;
  /** Provider 原始相关度分数，不做跨批次伪归一化。 */
  readonly score: number;
}

/** Provider 报告的重排用量；只收协议正式返回的 token 数（Jina 的 total_tokens），不读 meta。 */
export interface RerankUsage {
  readonly totalTokens: number;
}

export interface RerankResult {
  readonly results: readonly RerankItem[];
  readonly usage?: RerankUsage;
}
