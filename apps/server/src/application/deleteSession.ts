// Session 永久删除的跨域编排: 先停当前根工作, 再收交互与权限, 最后删数据与库外文件.
import { clearSessionRules } from '@ema-agent/permission';
import type { Composition } from '../composition/index.js';

/**
 * 顺序不可交换: 删除守卫先挡住新 Turn 并中止当前根工作; 等根 Turn 走完
 * finish 链(终态落库、交互清理、工具停驻)后才动数据行, 否则删除与未完成的
 * 持久化竞争. Memory 的 Session 级清理归 Sol 的 Memory 包收口后接入.
 */
export async function deleteSession(composition: Composition, sessionId: string): Promise<void> {
  const { database, tools, turn, characters } = composition;

  // 先禁止这个 Session 再启动新 Turn, 避免在删除过程中有新 Turn 进入.
  database.turns.beginSessionDeletion(sessionId);
  try {
    const runningTurn = database.turns.getRunningTurn(sessionId);
    if (runningTurn) {
      await turn.turnExecutor.abortAndAwait(sessionId, runningTurn.id);
    }
    // 后台 AgentRun 不属于当前根 Turn, 删除 Session 前必须单独停止并等其落终态.
    await turn.agentRuns.abortForSession(sessionId);
    // beginSessionDeletion() 已向当前的根 Turn 或手动 Compact 发出取消信号.
    // Turn 上面的 abortAndAwait() 可以等到 completion, 但手动 Compact 没有 Turn completion;
    // 因此这里等待两种工作中仍在运行的那一种自己停止并清除运行记录,
    // 然后才能删除 Session 数据.
    await database.sessionRunning.waitUntilIdle(sessionId);
    turn.interactionQueue.cancelForSession(sessionId, 'session deleted');
    turn.continuations.discardSession(sessionId);
    clearSessionRules(sessionId);
    await tools.discardSessionToolState(sessionId);
    // 数据行由外键级联; Session 目录文件由 SessionStore.onSessionRemoved 钩子清理.
    database.session.deleteSession(sessionId);
    database.turns.discardSession(sessionId);
    // 舞台是跨 Turn 内存状态, 跟随 Session 生命周期回收.
    characters.stage.evictSession(sessionId);
  } catch (error) {
    if (database.session.sessionExists(sessionId)) {
      database.turns.cancelSessionDeletion(sessionId);
    }
    throw error;
  }
}
