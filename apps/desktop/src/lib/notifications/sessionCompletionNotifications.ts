import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { useSessionStore } from '../../stores/session.js';
import { tauriBridge } from '../tauri/tauriBridge.js';
import type { SessionCompletionNotification } from '../tauri/types.js';

/** 只由 main 的完成事件或手动压缩入口调用. Rust 再判断 main 是否在前台查看同一聊天. */
export async function notifySessionCompletion(
  sessionId: string,
  id: string,
  kind: SessionCompletionNotification['kind'],
): Promise<void> {
  if (!tauriBridge.isTauri()) return;
  const navigation = useMainNavigationStore.getState();
  try {
    await tauriBridge.showSessionCompletion({
      id,
      sessionId,
      kind,
      title: useSessionStore.getState().sessions.byId.get(sessionId)?.title || '新对话',
      viewedSessionId: navigation.activeView === MainView.Chat ? navigation.viewedSessionId : null,
    });
  } catch (error) {
    // 系统通知不可用不改变已经保存的 Turn 或压缩结果, 聊天内仍可查看.
    console.warn('[session-completion-notification]', error);
  }
}
