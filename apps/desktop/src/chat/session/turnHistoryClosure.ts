// 按 Turn 开始顺序把同一 Session 的终态消息合入持久 History, 成功一条才删除一条.

import { useTurnStore } from '../../stores/turn.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useSessionStore } from '../../stores/session.js';
import { useTaskStore } from '../../stores/task.js';

const closureBySession = new Map<string, Promise<void>>();

/** terminal 事件可以连续到达;同一 Session 已有循环时不再启动第二条并发 History 请求. */
export function scheduleTurnHistoryClosure(sessionId: string): void {
  if (closureBySession.has(sessionId)) return;
  const closure = closeTerminalTurnsInOrder(sessionId).finally(() => {
    if (closureBySession.get(sessionId) === closure) closureBySession.delete(sessionId);
  });
  closureBySession.set(sessionId, closure);
}

/**
 * 每次只读取内层 Map 的第一条. 后一轮即使先结束, 也不能越过仍在运行或读取失败的前一轮,
 * 否则页面会变成 History T2 在前、当前 T1 在尾. HTTP 失败时保留原消息供后续重试.
 */
export async function closeTerminalTurnsInOrder(sessionId: string): Promise<void> {
  while (true) {
    const first = useTurnStore.getState().turnsBySession.get(sessionId)?.entries().next().value;
    if (!first) return;
    const [turnId, turn] = first;
    if (!turn.terminal) return;
    try {
      await useSessionHistoryStore.getState().mergeTurnMessages(sessionId, turnId);
    } catch (error) {
      console.warn(`[session] Turn ${turnId} History 收口失败:`, error);
      useSessionHistoryStore.getState().reportError(
        sessionId,
        error instanceof Error ? error.message : `Turn ${turnId} 消息合入失败`,
      );
      return;
    }
    useTurnStore.getState().removeTurn(sessionId, turnId);
    useSessionHistoryStore.getState().invalidateTurnIndex(sessionId);
    void useSessionStore.getState().loadSessions();
    void useTaskStore.getState().loadForSession(sessionId, true);
  }
}
