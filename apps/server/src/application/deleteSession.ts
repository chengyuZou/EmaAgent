// Session 永久删除的跨域编排：先停活动 Turn，再收交互与权限，最后删数据与库外文件。
import { clearSessionRules } from '@ema-agent/permission';
import type { Composition } from '../composition/index.js';

/**
 * 顺序不可交换：删除守卫先挡住新 Turn 并中止活动 Turn；等活动 Turn 走完
 * finish 链（终态落库、交互清理、工具停驻）后才动数据行，否则删除与在飞
 * 持久化竞争。Memory 的 Session 级清理归 Sol 的 Memory 包收口后接入。
 */
export async function deleteSession(composition: Composition, sessionId: string): Promise<void> {
  const { database, tools, turn, characters } = composition;

  database.turns.beginSessionDeletion(sessionId);
  try {
    const active = database.turns.getActiveTurn(sessionId);
    if (active) {
      await turn.turnExecutor.abortAndAwait(sessionId, active.id);
    }
    // 手动 compact 不是 Turn，abortAndAwait 等不到它：等 Session 坑位被
    // 执行所有者自己释放（compact 链收到信号后取消并清坑），再动数据行。
    await database.activeSessions.waitUntilIdle(sessionId);
    turn.interactionQueue.cancelForSession(sessionId, 'session deleted');
    clearSessionRules(sessionId);
    await tools.discardSessionToolState(sessionId);
    // 数据行由外键级联；Session 目录文件由 SessionStore.onSessionRemoved 钩子清理。
    database.session.deleteSession(sessionId);
    database.turns.discardSession(sessionId);
    // 舞台是跨 Turn 内存状态，跟随 Session 生命周期回收。
    characters.stage.evictSession(sessionId);
  } catch (error) {
    if (database.session.sessionExists(sessionId)) {
      database.turns.cancelSessionDeletion(sessionId);
    }
    throw error;
  }
}
