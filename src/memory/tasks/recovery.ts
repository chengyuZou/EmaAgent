// 启动时恢复 Memory 租约、孤儿软引用与需要后续修复的持久状态。

import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import { bestEffort } from '../best-effort.js';
import { cleanupOrphanSessionMemoryReferences } from '../sessionCleanup.js';

export interface RecoveryReport {
  resetTasks:        number;
  pendingSessions:   number;
  staleNodeEmbeds:   number;
  staleItemEmbeds:   number;
  orphanLazyUpdates: number;
  orphanSourceSessions: number;
  orphanSourceReferences: number;
}

/**
 * 在 Data Directory 独占启动锁之后执行 Memory 恢复。
 * 各检查互相隔离：单项失败只保留默认报告，不能阻止本地后端启动。
 */
export function runStartupRecovery(
  deps: MemoryDeps,
  embed: EmbedService,
): RecoveryReport {
  const now = Date.now();
  const report: RecoveryReport = {
    resetTasks:        0,
    pendingSessions:   0,
    staleNodeEmbeds:   0,
    staleItemEmbeds:   0,
    orphanLazyUpdates: 0,
    orphanSourceSessions: 0,
    orphanSourceReferences: 0,
  };

  report.resetTasks = bestEffort(
    'recovery recoverRunningAfterExclusiveStartup',
    () => deps.memoryTasks.recoverRunningAfterExclusiveStartup(now),
    0,
  );

  report.orphanLazyUpdates = bestEffort('recovery cleanOrphans', () => deps.lazyUpdates.cleanOrphans(), 0);

  const orphanSources = bestEffort(
    'recovery cleanupOrphanSessionMemoryReferences',
    () => cleanupOrphanSessionMemoryReferences(deps),
    { orphanSessions: 0, referencesChanged: 0 },
  );
  report.orphanSourceSessions = orphanSources.orphanSessions;
  report.orphanSourceReferences = orphanSources.referencesChanged;

  report.pendingSessions = bestEffort('recovery listSessionsWithPending',
    () => deps.pendingFragments.listSessionsWithPending().length, 0);

  const model = embed.resolveEmbed();
  const dim = model ? deps.getEmbedDim(model.providerId, model.model) : undefined;
  const space = dim ? embed.currentSpace(dim) : null;
  if (space) {
    report.staleNodeEmbeds = bestEffort('recovery countStaleEmbeddings(nodes)', () => deps.nodes.countStaleEmbeddings(space.id), 0);
    report.staleItemEmbeds = bestEffort('recovery countStaleEmbeddings(items)', () => deps.items.countStaleEmbeddings(space.id), 0);
  }

  return report;
}
