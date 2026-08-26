// 把跨窗口收到的系统事件写入当前窗口自己的前端 Store。

import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';
import { useBackgroundProcessStore } from '../stores/backgroundProcessStore.js';
import { useCharacterStore } from '../stores/character-store.js';
import { useKnowledgeStore } from '../stores/knowledge-store.js';

export function dispatchSystemEvent(event: AppEvent): void {
  switch (event.type) {
    case 'character_switched':
    case 'character_presentation_changed':
      void useCharacterStore.getState().load();
      break;

    case 'kb_ingest_progress':
      useKnowledgeStore.getState().onIngestProgress(
        event.kbId,
        event.taskId,
        event.assetId,
        event.stage,
        event.progress,
      );
      break;

    case 'kb_ingest_completed':
      useKnowledgeStore.getState().onIngestCompleted(event.kbId, event.taskId, event.assetId);
      break;

    case 'kb_ingest_failed':
      useKnowledgeStore.getState().onIngestFailed(event.kbId, event.taskId, event.assetId, event.error);
      break;

    case 'kb_reembed_progress':
      useKnowledgeStore.getState().onReembedProgress(
        event.kbId,
        event.taskId,
        event.assetId,
        event.progress,
        { total: event.total, completed: event.completed },
      );
      break;

    case 'kb_reembed_completed':
      useKnowledgeStore.getState().onReembedCompleted(event.kbId, event.taskId, event.assetId);
      break;

    case 'kb_reembed_cancelled':
      useKnowledgeStore.getState().onReembedCancelled(event.kbId, event.taskId, event.assetId);
      break;

    case 'kb_reembed_failed':
      useKnowledgeStore.getState().onReembedFailed(event.kbId, event.taskId, event.assetId, event.error);
      break;

    case 'background_process_changed':
      // 面板只原位更新已加载的行;未加载的 Session 不预取,等打开再拉。
      useBackgroundProcessStore.getState().applyEvent(event);
      break;

    default:
      break;
  }
}
