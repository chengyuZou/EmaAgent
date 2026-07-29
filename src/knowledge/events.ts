// 定义知识库导入和重新嵌入任务向应用公开的进度事件。
import type { SessionId } from '@ema-agent/ids';

export type KnowledgeEvent =
  | { type: 'kb_ingest_progress'; kbId: string; taskId?: string; assetId: string; stage: 'validate' | 'parse' | 'chunk' | 'embed'; progress: number; totalItems?: number; completedItems?: number; failedItems?: number; sessionId?: SessionId }
  | { type: 'kb_ingest_completed'; kbId: string; taskId?: string; assetId: string; sessionId?: SessionId }
  | { type: 'kb_ingest_partial_failed'; kbId: string; taskId?: string; assetId: string; error: string; totalItems: number; completedItems: number; failedItems: number; sessionId?: SessionId }
  | { type: 'kb_ingest_failed'; kbId: string; taskId?: string; assetId: string; error: string; sessionId?: SessionId }
  | { type: 'kb_reembed_progress'; kbId: string; taskId?: string; assetId: string; progress: number; totalItems?: number; completedItems?: number; failedItems?: number }
  | { type: 'kb_reembed_completed'; kbId: string; taskId?: string; assetId: string; totalItems: number; completedItems: number; failedItems: number }
  | { type: 'kb_reembed_partial_failed'; kbId: string; taskId?: string; assetId: string; error: string; totalItems: number; completedItems: number; failedItems: number }
  | { type: 'kb_reembed_cancelled'; kbId: string; taskId?: string; assetId: string }
  | { type: 'kb_reembed_failed'; kbId: string; taskId?: string; assetId: string; error: string }
  // embed 模型绑定变更后自动标记 stale 完成，引导用户重嵌；不属于单个 KB。
  | { type: 'kb_embeddings_staled'; markedStale: number; kbCount: number; failedKbIds: string[]; providerConfigId: string; model: string };
