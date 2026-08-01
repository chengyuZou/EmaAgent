// 把跨窗口收到的系统事件写入当前窗口自己的前端 Store。
import type { AppEvent } from '@ema-agent/events';
import type { MemoryTaskKind } from '@ema-agent/storage';
import { useBackgroundProcessStore } from '../stores/backgroundProcessStore.js';
import { useCardStore } from '../stores/card-store.js';
import { useKbStore } from '../stores/kb-store.js';
import { useMemoryStore } from '../stores/memory-store.js';
import { useSettingsStore } from '../stores/settings-store.js';

export function dispatchSystemEvent(event: AppEvent): void {
  switch (event.type) {
    case 'character_card_switched':
    case 'character_presentation_changed':
      void useCardStore.getState().load();
      break;

    case 'memory_task_started':
      // contracts 不依赖 storage，Core 只会在该事件中发送合法的 MemoryTaskKind。
      useMemoryStore.getState().onTaskStarted(
        event.taskId,
        event.kind as MemoryTaskKind,
        event.sessionId as string | undefined,
      );
      break;

    case 'memory_task_completed':
      useMemoryStore.getState().onTaskCompleted(event.taskId);
      break;

    case 'memory_task_failed':
      useMemoryStore.getState().onTaskFailed(event.taskId, event.error);
      break;

    case 'memory_extraction_started':
      useMemoryStore.getState().onExtractionStarted(event.sessionId as string);
      break;

    case 'memory_extraction_completed':
      useMemoryStore.getState().onExtractionCompleted(event.sessionId as string, {
        nodes: event.nodes,
        edges: event.edges,
        items: event.items,
        lazyQueued: event.lazyQueued,
        durationMs: event.durationMs,
      });
      // 提取产生了新节点/条目,统计快照已过期。
      void useMemoryStore.getState().refreshStats();
      break;

    case 'memory_extraction_failed':
      useMemoryStore.getState().onExtractionFailed(event.sessionId as string, event.error);
      break;

    case 'memory_index_rebuilt':
      useMemoryStore.getState().onIndexRebuilt();
      break;

    case 'memory_maintenance_completed':
      useMemoryStore.getState().onMaintenanceCompleted(
        event.decayedNodes,
        event.decayedItems,
        event.dryRun,
      );
      break;

    case 'memory_maintenance_failed':
      useMemoryStore.getState().onMaintenanceFailed(event.error);
      break;

    case 'kb_ingest_progress':
      useKbStore.getState().onIngestProgress(
        event.kbId,
        event.taskId,
        event.assetId,
        event.stage,
        event.progress,
      );
      break;

    case 'kb_ingest_completed':
      useKbStore.getState().onIngestCompleted(event.kbId, event.assetId);
      break;

    case 'kb_ingest_partial_failed':
      useKbStore.getState().onIngestPartialFailed(
        event.kbId,
        event.taskId,
        event.assetId,
        event.error,
        {
          total: event.totalItems,
          completed: event.completedItems,
          failed: event.failedItems,
        },
      );
      break;

    case 'kb_ingest_failed':
      useKbStore.getState().onIngestFailed(event.kbId, event.assetId, event.error);
      break;

    case 'kb_reembed_progress':
      useKbStore.getState().onReembedProgress(
        event.kbId,
        event.taskId,
        event.assetId,
        event.progress,
        {
          total: event.totalItems,
          completed: event.completedItems,
          failed: event.failedItems,
        },
      );
      break;

    case 'kb_reembed_completed':
      useKbStore.getState().onReembedCompleted(
        event.kbId,
        event.taskId,
        event.assetId,
        {
          total: event.totalItems,
          completed: event.completedItems,
          failed: event.failedItems,
        },
      );
      break;

    case 'kb_reembed_partial_failed':
      useKbStore.getState().onReembedPartialFailed(
        event.kbId,
        event.taskId,
        event.assetId,
        event.error,
        {
          total: event.totalItems,
          completed: event.completedItems,
          failed: event.failedItems,
        },
      );
      break;

    case 'kb_reembed_cancelled':
      useKbStore.getState().onReembedCancelled(event.kbId, event.taskId, event.assetId);
      break;

    case 'kb_reembed_failed':
      useKbStore.getState().onReembedFailed(
        event.kbId,
        event.taskId,
        event.assetId,
        event.error,
      );
      break;

    case 'kb_embeddings_staled':
      // stale 标记落在后端 SQLite；重读文档列表让"需要重嵌"徽标立即出现。
      void useKbStore.getState().loadDocuments();
      break;

    case 'background_process_changed':
      // 面板只原位更新已加载的行;未加载的 Session 不预取,等打开再拉。
      useBackgroundProcessStore.getState().applyEvent(event);
      break;

    case 'memory_storage_budget_enforced':
      // 预算执行驱逐了记录与向量,统计快照已过期。
      void useMemoryStore.getState().refreshStats();
      break;

    case 'memory_background_health_changed':
      // 只在进入/退出退化边界发布(M5),原位替换健康投影。
      useMemoryStore.getState().onHealthChanged(event.health);
      break;

    case 'memory_consolidation_completed':
      // 归并合并了节点,统计快照已过期;started/failed 无需动作。
      void useMemoryStore.getState().refreshStats();
      break;

    // 这些事件为后续 Memory 轮次预留，当前没有前端状态需要更新。
    case 'memory_consolidation_started':
    case 'memory_consolidation_failed':
    case 'memory_node_merged':
      break;

    default:
      break;
  }
}
