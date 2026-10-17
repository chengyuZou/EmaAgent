import type { RerankProtocol } from '@ema-agent/providers';

export type { RerankProtocol } from '@ema-agent/providers';

export interface RerankConnection {
  readonly protocol: RerankProtocol;
  /** 本地服务或网关可以不需要凭据. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface RerankRequest {
  readonly query: string;
  readonly documents: readonly string[];
  /** 默认取至多 5 条, 大于 documents 数量时使用文档数量. */
  readonly topK?: number;
  readonly signal?: AbortSignal;
}

/** 模型和协议在 createRerankCall 时选定. */
export type CallRerank = (request: RerankRequest) => Promise<RerankResult>;

export interface RerankItem {
  /** 对应请求 documents 的原始下标, 不是排序后的序号. */
  readonly index: number;
  /** 保留供应商原始分数, 不按本批次的最高分和最低分重新换算. */
  readonly score: number;
}

/** 供应商报告的处理 Token; 未报告时不估算, 不把 search_units 当 Token. */
export interface RerankUsage {
  readonly inputTokens: number;
  readonly outputTokens?: number;
}

export interface RerankResult {
  readonly results: readonly RerankItem[];
  readonly usage?: RerankUsage;
}
