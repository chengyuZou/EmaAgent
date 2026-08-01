/** 推给 Bridge 的 embedding 配置快照(LightRAG 内部向量化用) */
export interface BridgeEmbedCfg {
  protocol: 'openai-embed';   // LightRAG bridge only supports openai-compat embed
  apiKey: string;
  baseUrl: string;
  model: string;
  dim?: number;
}

/** 推给 Bridge 的 LLM 配置快照(LightRAG 实体抽取 + 周目路由用) */
export interface BridgeLlmCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 
 *   - 删：NarrativeRouteRequest/Response、NarrativeQueryRequest/Response、NarrativeIngestRequest/Response（端点退位 + ingest 消失）。
  - 增：NarrativeRecallRequest { query, mode?, topK? }、NarrativeTimelineFailure { timeline, code, message, retryable }、NarrativeRecallResponse { generationId, routes, results, failures }。
*/

/**
 * POST /internal/configure 的完整配置快照。
 * null 表示显式撤销该能力，避免 Bridge 继续持有已删除 Provider 的密钥。
 */
export interface BridgeConfigurePayload {
  embed: BridgeEmbedCfg | null;
  llm:   BridgeLlmCfg | null;
}

export interface BridgeCapabilities {
  embed:     boolean;
  llm:       boolean;
  narrative: boolean;
}

export interface BridgeHealthResponse {
  status:       'ok';
  version:      string;
  capabilities: BridgeCapabilities;
}

export interface NarrativeRecallRequest {
  query: string;
  mode?: string; // LightRAG query mode. 默认为 'hybrid'.
  topK?: number; // LightRAG topK. 默认为 5.
}

export interface NarrativeTimelineFailure {
  timeline: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface NarrativeRecallResponse {
  generationId: string;
  routes: Record<string, string>;
  results: Record<string, string>;
  failures: NarrativeTimelineFailure[];
}

// ── Route ─────────────────────────────────────────────────────────────────────

export interface NarrativeRouteRequest {
  query: string;
}

/** 路由结果——时间线 -> 为该时间线改写好的子查询
 * 魔裁中有 3 个时间线：1st_Loop, 2nd_Loop, 3rd_Loop
 * bridge会根据一个整剧情SummaryPrompt对query进行改写，返回可能存在的每个时间线的子查询
 */
export interface NarrativeRouteResponse {
  routes: Record<string, string>;
}

// ── Query ─────────────────────────────────────────────────────────────────────

export interface NarrativeQueryRequest {
  /** 批量查询请求——多时间线子查询 + LightRAG 检索模式 */
  queries: Record<string, string>;
  /** LightRAG query mode. 默认为 'hybrid'. */
  mode?: string;
}

export interface NarrativeQueryResponse {
  /** 时间线 → 召回的叙事文本。 */
  results: Record<string, string>;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

export interface NarrativeIngestRequest {
  /** 必须是以下之一：1st_Loop, 2nd_Loop, 3rd_Loop */
  timeline: string;
  /** 原始文本文档，用于推入 LightRAG。 */
  documents: string[];
}

export interface NarrativeIngestResponse {
  /** 本次调用接受的文档数量。 */
  accepted: number;
}
