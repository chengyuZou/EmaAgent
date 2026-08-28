// Server 与 Narrative Bridge 的请求/响应形状；与 bridges/narrative/core/contracts.py 同批维护。

/** LightRAG 检索模式；仅改变检索策略，最终回答永远由根 Agent 生成。 */
export type NarrativeQueryMode = 'local' | 'global' | 'hybrid' | 'naive' | 'mix';

/** 一次 Recall 携带的 openai-llm 连接；Bridge 不持有任何全局 LLM 状态。 */
export interface NarrativeLlmConnection {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
}

/** 进程级 Embedding 连接：向量空间与既有剧情数据一体，进程内不可更换。 */
export interface NarrativeEmbeddingConnection {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  dim: number;
}

export interface NarrativeBridgeConfigureRequest {
  embed: NarrativeEmbeddingConnection;
}

export interface NarrativeRecallRequest {
  query: string;
  llm: NarrativeLlmConnection;
  /** LightRAG 检索模式，默认 hybrid。 */
  mode?: NarrativeQueryMode;
  /** 每条时间线的 LightRAG 召回上限，默认 40。 */
  topK?: number;
}

export type NarrativeTimelineFailureCode = 'timeline_query_failed';

export interface NarrativeTimelineFailure {
  timeline: string;
  code: NarrativeTimelineFailureCode;
  message: string;
}

/** 一次完成路由和全部时间线查询的原子响应。 */
export interface NarrativeRecallResponse {
  routes: Record<string, string>;
  results: Record<string, string>;
  failures: NarrativeTimelineFailure[];
}
