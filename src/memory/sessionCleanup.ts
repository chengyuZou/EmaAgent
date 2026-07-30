// 清理 Session 删除后留在 Profile DB 的 Memory 软引用，同时保留已经形成的长期记忆。

import { asSessionId, type SessionId } from '@ema-agent/ids';
import type { MemoryDeps } from './deps.js';

export interface SessionMemoryCleanupReport {
  nodeSourcesDeleted: number;
  lazySourcesDetached: number;
  itemSourcesDetached: number;
  recoveryRunsDeleted: number;
}

export interface OrphanSessionMemoryCleanupReport {
  orphanSessions: number;
  referencesChanged: number;
}

/** 在一个 Profile DB 事务中清掉指定 Session 的全部跨库软引用。 */
export function cleanupSessionMemoryReferences(
  deps: MemoryDeps,
  sessionId: SessionId,
): SessionMemoryCleanupReport {
  return deps.runProfileTransaction(() => ({
    nodeSourcesDeleted: deps.nodeSources.deleteBySession(sessionId),
    lazySourcesDetached: deps.lazyUpdates.detachSourceSession(sessionId),
    itemSourcesDetached: deps.items.detachSourceSession(sessionId),
    recoveryRunsDeleted: deps.extractionRuns.deleteBySession(sessionId),
  }));
}

/**
 * 启动恢复时以 Data DB Session 为事实源。崩溃若发生在 Data 删除和 Profile
 * 清理之间，下一次独占启动会补完清理。
 */
export function cleanupOrphanSessionMemoryReferences(
  deps: MemoryDeps,
): OrphanSessionMemoryCleanupReport {
  const referencedSessions = new Set<string>([
    ...deps.nodeSources.listSourceSessionIds(),
    ...deps.lazyUpdates.listSourceSessionIds(),
    ...deps.items.listSourceSessionIds(),
    ...deps.extractionRuns.listSessionIds(),
  ]);

  let orphanSessions = 0;
  let referencesChanged = 0;
  for (const rawSessionId of [...referencedSessions].sort()) {
    const sessionId = asSessionId(rawSessionId);
    if (deps.session.sessionExists(sessionId)) continue;

    const report = cleanupSessionMemoryReferences(deps, sessionId);
    orphanSessions++;
    referencesChanged +=
      report.nodeSourcesDeleted +
      report.lazySourcesDetached +
      report.itemSourcesDetached +
      report.recoveryRunsDeleted;
  }

  return { orphanSessions, referencesChanged };
}
