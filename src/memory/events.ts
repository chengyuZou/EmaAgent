// 定义 Memory 召回、提取、维护和后台任务产生的业务事件。
import type { ExecutionProfile } from '@ema-agent/turn-terms';

export type MemoryRecallLayer = 'layer0' | 'layer1' | 'layer2';
export type MemoryRecallLayerStatus = 'succeeded' | 'skipped' | 'failed';

export type MemoryBackgroundOperation =
  | 'initialization'
  | 'decay'
  | 'consolidation'
  | 'embeddingRepair'
  | 'storageBudget';

export interface MemoryBackgroundFailure {
  operation: MemoryBackgroundOperation;
  occurredAt: number;
  /** 只提供可公开的业务说明，不暴露异常堆栈、Prompt 或 Provider 响应。 */
  message: string;
}

export interface MemoryStoragePressure {
  usedBytes: number;
  maxBytes: number;
  remainsOverLimit: boolean;
}

/** 宿主进程内的 Memory 后台维护投影，重启后从空闲状态重新建立。 */
export interface MemoryBackgroundHealth {
  state: 'idle' | 'running' | 'degraded';
  activeOperation?: MemoryBackgroundOperation;
  lastCompletedAt?: number;
  lastFailure?: MemoryBackgroundFailure;
  consecutiveFailures: number;
  storagePressure?: MemoryStoragePressure;
}

export interface MemoryRecallLayerReport {
  status: MemoryRecallLayerStatus;
  itemCount: number;
  tokenEstimate: number;
  durationMs: number;
  error?: string;
  skippedReason?: string;
}

export type MemoryRecallEvent =
  | {
      type: 'memory_recall_evidence';
      sessionId: string;
      turnId: string;
      executionProfile: ExecutionProfile;
      layer: MemoryRecallLayer;
      report: MemoryRecallLayerReport;
    }
  | {
      /** 召回整体失败并降级为空贡献；Turn 继续，不带 Memory 上下文。 */
      type: 'memory_recall_unavailable';
      sessionId: string;
      turnId: string;
      error: string;
      retryable: boolean;
    };

export type MemoryBackgroundEvent =
  | { type: 'memory_extraction_started'; sessionId: string; turnId?: string; queueDepth: number }
  | { type: 'memory_extraction_completed'; sessionId: string; nodes: number; edges: number; items: number; lazyQueued: number; durationMs: number }
  | { type: 'memory_extraction_failed'; sessionId: string; error: string }
  | { type: 'memory_extraction_skipped'; sessionId: string; reason: string }
  | { type: 'memory_index_rebuilt'; backend: string; nodes: number; items: number; durationMs: number }
  | { type: 'memory_consolidation_started'; nodeCount: number }
  | { type: 'memory_consolidation_completed'; consolidated: number; durationMs: number }
  | { type: 'memory_consolidation_failed'; error: string }
  | { type: 'memory_maintenance_completed'; decayedNodes: number; decayedItems: number; dryRun: boolean; durationMs: number }
  | { type: 'memory_maintenance_failed'; error: string }
  | {
      type: 'memory_storage_budget_enforced';
      beforeBytes: number;
      afterBytes: number;
      maxBytes: number;
      deletedRows: number;
      evictedEmbeddings: number;
      pressureRemaining: boolean;
    }
  | {
      /** 只在进入或离开退化状态时发布，正常扫描和预期抢占不产生通知噪音。 */
      type: 'memory_background_health_changed';
      health: MemoryBackgroundHealth;
    }
  | { type: 'memory_node_merged'; nodeId: string; label: string; fragmentCount: number }
  | { type: 'memory_task_started'; taskId: string; kind: string; sessionId?: string }
  | { type: 'memory_task_completed'; taskId: string; kind: string; durationMs: number }
  | { type: 'memory_task_failed'; taskId: string; kind: string; error: string };

export type MemoryEvent = MemoryRecallEvent | MemoryBackgroundEvent;
