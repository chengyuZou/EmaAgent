// 定义 Memory 召回、提取、维护和后台任务产生的业务事件。
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { ExecutionProfile } from '@ema-agent/turn';

export type MemoryRecallLayer = 'layer0' | 'layer1' | 'layer2';
export type MemoryRecallLayerStatus = 'succeeded' | 'skipped' | 'failed';

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
      sessionId: SessionId;
      turnId: TurnId;
      executionProfile: ExecutionProfile;
      layer: MemoryRecallLayer;
      report: MemoryRecallLayerReport;
    }
  | {
      /** 召回整体失败并降级为空贡献；Turn 继续，不带 Memory 上下文。 */
      type: 'memory_recall_unavailable';
      sessionId: SessionId;
      turnId: TurnId;
      error: string;
      retryable: boolean;
    };

export type MemoryBackgroundEvent =
  | { type: 'memory_extraction_started'; sessionId: SessionId; turnId?: TurnId; queueDepth: number }
  | { type: 'memory_extraction_completed'; sessionId: SessionId; nodes: number; edges: number; items: number; lazyQueued: number; durationMs: number }
  | { type: 'memory_extraction_failed'; sessionId: SessionId; error: string }
  | { type: 'memory_index_rebuilt'; backend: string; nodes: number; items: number; durationMs: number }
  | { type: 'memory_consolidation_started'; nodeCount: number }
  | { type: 'memory_consolidation_completed'; consolidated: number; durationMs: number }
  | { type: 'memory_consolidation_failed'; error: string }
  | { type: 'memory_maintenance_completed'; decayedNodes: number; decayedItems: number; dryRun: boolean; durationMs: number }
  | { type: 'memory_maintenance_failed'; error: string }
  | { type: 'memory_node_merged'; nodeId: string; label: string; fragmentCount: number }
  | { type: 'memory_task_started'; taskId: string; kind: string; sessionId?: SessionId }
  | { type: 'memory_task_completed'; taskId: string; kind: string; durationMs: number }
  | { type: 'memory_task_failed'; taskId: string; kind: string; error: string };

export type MemoryEvent = MemoryRecallEvent | MemoryBackgroundEvent;
