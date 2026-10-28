import { clearSessionApprovals } from '@ema-agent/permission';
import type { Composition } from '../composition/index.js';
import { removeSessionFiles } from '../platform/paths.js';

export interface ArchivedSessionsDeletionResult {
  readonly deletedSessionIds: readonly string[];
  /** SQL 已提交后的清理失败, 不表示数据库删除被回滚. */
  readonly cleanupFailures: readonly {
    readonly sessionId: string;
    readonly message: string;
  }[];
}

export async function archiveSession(
  composition: Composition,
  sessionId: string,
): Promise<void> {
  composition.database.session.getSession(sessionId);
  await composition.database.sessionRunning.runWithSessionClosed(sessionId, async () => {
    // 归档事实先保存, 后续请求和进程重启都不能再启动这个会话的工作.
    composition.database.session.archiveSession(sessionId);
    await stopSessionWork(composition, sessionId, 'Session archived');
  });
}

export async function deleteSession(
  composition: Composition,
  sessionId: string,
): Promise<void> {
  const { database, tools, characters } = composition;
  database.session.getSession(sessionId);
  await database.sessionRunning.runWithSessionClosed(sessionId, async () => {
    await stopSessionWork(composition, sessionId, 'Session deleted');
    clearSessionApprovals(sessionId);
    await tools.discardSessionToolState(sessionId);
    // 所有执行完成最后的保存后才删数据和附件, 避免写入已删除的行或目录.
    database.session.deleteSession(sessionId);
    database.turns.discardSession(sessionId);
    characters.stage.evictSession(sessionId);
  });
}

export async function deleteArchivedSessions(
  composition: Composition,
): Promise<ArchivedSessionsDeletionResult> {
  const { database, tools, characters, appEvents } = composition;
  const deletedSessionIds = database.session.deleteArchivedSessions();
  const cleanupFailures: Array<{ sessionId: string; message: string }> = [];

  // 这些会话已经完成归档, 不重复停止工作. 磁盘和异步操作不能放进 SQLite 事务.
  for (const sessionId of deletedSessionIds) {
    clearSessionApprovals(sessionId);
    try {
      await tools.discardSessionToolState(sessionId);
    } catch (error) {
      cleanupFailures.push({
        sessionId,
        message: error instanceof Error ? error.message : '工具缓存清理失败',
      });
    }
    database.turns.discardSession(sessionId);
    characters.stage.evictSession(sessionId);
    try {
      removeSessionFiles(database.activeDataDir, sessionId);
    } catch (error) {
      cleanupFailures.push({
        sessionId,
        message: error instanceof Error ? error.message : '会话文件清理失败',
      });
    }
  }
  if (deletedSessionIds.length > 0) {
    appEvents.emit({ type: 'sessions_deleted', sessionIds: deletedSessionIds });
  }
  return { deletedSessionIds, cleanupFailures };
}

async function stopSessionWork(
  composition: Composition,
  sessionId: string,
  reason: string,
): Promise<void> {
  const { database, tools, turn, speech } = composition;
  const goal = database.goals.getCurrent(sessionId);
  if (goal) {
    database.goals.cancel({ sessionId, goalId: goal.id, expectedVersion: goal.version });
  }
  turn.continuations.clearSession(sessionId);
  turn.interactionQueue.cancelForSession(sessionId, reason);

  // 先向所有执行发出停止请求, 不能等主任务结束后才停子代理或命令.
  const running = database.sessionRunning.getRunning(sessionId);
  const completions = [
    composition.computerUse?.endSession(sessionId) ?? Promise.resolve(),
    composition.vishotCapture.capture.cancelSession(sessionId),
    turn.subagents.abortForSession(sessionId, reason),
    tools.backgroundProcesses.stopForSession(sessionId),
    speech.cancelSessionSpeech(sessionId),
    database.sessionRunning.waitUntilIdle(sessionId),
  ];
  if (running?.kind === 'turn') {
    completions.push(turn.turnExecutor.abortAndAwait(sessionId, running.turnId));
  }
  const results = await Promise.allSettled(completions);
  // 主任务准备过程中可能刚登记语音任务, 此时主任务已停止, 再等它保存取消结果.
  await speech.cancelSessionSpeech(sessionId);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
