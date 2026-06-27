import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import { bestEffort } from '../best-effort.js';

export interface RecoveryReport {
  resetTasks:        number;
  pendingSessions:   number;
  staleNodeEmbeds:   number;
  staleItemEmbeds:   number;
  orphanLazyUpdates: number;
}

/**
 * Run all startup hygiene checks for the memory subsystem.
 *
 * Steps:
 *   1. Reset background_tasks where status='running' → 'pending' (process crash recovery)
 *   2. Clean orphan lazy_updates rows (defensive; ON DELETE CASCADE usually covers this)
 *   3. Count stale embeddings (provider mismatch) — enqueue a refresh task
 *   4. Find sessions with non-empty pending_fragments — caller can decide to
 *      auto-catchup or wait until the session is reopened
 *
 * All steps are tolerant — individual failures are recorded but never thrown.
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
  };

  report.resetTasks = bestEffort('recovery resetStuckRunning', () => deps.memoryTasks.resetStuckRunning(now), 0);

  report.orphanLazyUpdates = bestEffort('recovery cleanOrphans', () => deps.lazyUpdates.cleanOrphans(), 0);

  report.pendingSessions = bestEffort('recovery listSessionsWithPending',
    () => deps.pendingFragments.listSessionsWithPending().length, 0);

  const providerId = embed.currentProviderId();
  if (providerId) {
    report.staleNodeEmbeds = bestEffort('recovery countStaleEmbeddings(nodes)', () => deps.nodes.countStaleEmbeddings(providerId), 0);
    report.staleItemEmbeds = bestEffort('recovery countStaleEmbeddings(items)', () => deps.items.countStaleEmbeddings(providerId), 0);
  }

  return report;
}
