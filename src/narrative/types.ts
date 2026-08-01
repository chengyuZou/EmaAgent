export interface NarrativeBridgeEmbedConfig {
  /** Narrative Bridge 的 LightRAG 目前只接受 OpenAI 兼容嵌入协议。 */
  protocol: 'openai-embed';
  apiKey: string;
  baseUrl: string;
  model: string;
  dim?: number;
}

export interface NarrativeBridgeLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** null 表示显式撤销能力，避免 Bridge 继续持有已删除 Provider 的密钥。 */
export interface NarrativeBridgeConfigurePayload {
  embed: NarrativeBridgeEmbedConfig | null;
  llm: NarrativeBridgeLlmConfig | null;
}

export interface NarrativeRecallRequest {
  query: string;
  /** LightRAG 检索模式，默认 hybrid。 */
  mode?: 'local' | 'global' | 'hybrid' | 'naive' | 'mix';
  /** 每条时间线的 LightRAG 召回上限，默认 40。 */
  topK?: number;
}

export type NarrativeTimelineFailureCode = 'timeline_query_failed';

export interface NarrativeTimelineFailure {
  timeline: string;
  code: NarrativeTimelineFailureCode;
  message: string;
  retryable: boolean;
}

/** 一个 Bridge 代际内完成路由和全部时间线查询的原子响应。 */
export interface NarrativeRecallResponse {
  generationId: string;
  routes: Record<string, string>;
  results: Record<string, string>;
  failures: NarrativeTimelineFailure[];
}
