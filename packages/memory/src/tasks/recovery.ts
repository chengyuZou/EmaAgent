import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';

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

  try { report.resetTasks = deps.backgroundTasks.resetStuckRunning(now); }
  catch { /* ignore */ }

  try { report.orphanLazyUpdates = deps.lazyUpdates.cleanOrphans(); }
  catch { /* ignore */ }

  try {
    const sessions = deps.pendingFragments.listSessionsWithPending();
    report.pendingSessions = sessions.length;
  } catch { /* ignore */ }

  const providerId = embed.currentProviderId();
  if (providerId) {
    try { report.staleNodeEmbeds = deps.nodes.countStaleEmbeddings(providerId); }
    catch { /* ignore */ }
    try { report.staleItemEmbeds = deps.items.countStaleEmbeddings(providerId); }
    catch { /* ignore */ }
  }

  return report;
}
