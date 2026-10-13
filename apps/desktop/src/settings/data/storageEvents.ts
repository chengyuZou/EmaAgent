import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import { subscribeSystemEvent } from '../../lib/events/systemEventDispatcher.js';

/** 只选取会改变存储计数的持久事件, 不响应流式文字和播放进度. */
export function storageEventSessionId(event: AppEvent): string | undefined {
  switch (event.type) {
    case 'session_list_changed':
    case 'session_messages_changed':
    case 'session_audio_changed':
    case 'attachments_changed':
    case 'tasks_changed':
    case 'turn_started':
    case 'turn_completed':
    case 'turn_failed':
    case 'turn_aborted':
    case 'goal_deleted':
      return event.sessionId;
    default:
      if ('goal' in event) {
        return event.goal.sessionId;
      }
      return undefined;
  }
}

/** 未指定 sessionId 时更新总览; 指定时仅刷新对应会话, 合并紧邻的保存通知. */
export function subscribeStorageChanges(sessionId: string | undefined, refresh: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = subscribeSystemEvent(event => {
    const changedSessionId = storageEventSessionId(event);
    if (changedSessionId === undefined || (sessionId !== undefined && changedSessionId !== sessionId)) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
