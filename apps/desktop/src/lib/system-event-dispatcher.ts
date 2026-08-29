// 把跨窗口收到的系统事件写入当前窗口自己的前端 Store。

import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';
import { useBackgroundProcessStore } from '../stores/backgroundProcess.js';
import { useCharacterStore } from '../stores/character.js';
import { useCurrentSession } from '../chat/state/currentSession.js';
import { useKnowledgeStore } from '../stores/knowledge.js';
import { useSettingsStore } from '../stores/settings.js';

export function dispatchSystemEvent(event: AppEvent): void {
  switch (event.type) {
    case 'character_switched':
      // 旧角色的情绪语义名在新角色映射下无意义：清记忆，避免补发给新角色。
      useCurrentSession.getState().clearEmotions();
      void useCharacterStore.getState().load();
      break;

    case 'character_presentation_changed':
      void useCharacterStore.getState().load();
      break;

    case 'kb_ingest_progress':
    case 'kb_ingest_completed':
    case 'kb_ingest_failed':
    case 'kb_reembed_progress':
    case 'kb_reembed_completed':
    case 'kb_reembed_cancelled':
    case 'kb_reembed_failed':
      useKnowledgeStore.getState().applyKnowledgeEvent(event);
      break;

    case 'background_process_changed':
      // 面板只原位更新已加载的行;未加载的 Session 不预取,等打开再拉。
      useBackgroundProcessStore.getState().applyEvent(event);
      break;

    case 'settings_changed':
      // 每个 WebView 都有自己的 Store；收到后读取后端生效值，兑现 nextOperation。
      void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
      break;

    default:
      break;
  }
}
