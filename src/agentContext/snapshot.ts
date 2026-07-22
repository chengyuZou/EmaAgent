import type { AgentFileStateStore } from './fileState.js';

// ── AgentContextSnapshot ──────────────────────────────────────────────────────
//
// Read-only aggregate view of an agent session's working set. Used by the
// memory planner's post-compact restore step: after macro-compaction collapses
// old messages into a summary, the planner asks the snapshot which files were
// recently in context so it can re-inject the most relevant ones.
//
// This is NOT a new persistence layer. It reads live state from the file-state
// store (and could read more sub-stores later). Crash recovery is handled by
// the messages table, not here.

export interface AgentContextSnapshot {
  sessionId: string;
  /** Most-recently-read file paths, newest first. */
  recentFiles: string[];
  /** When the snapshot was taken. */
  takenAtMs: number;
}

export interface SnapshotSources {
  sessionId: string;
  fileState: AgentFileStateStore;
}

/**
 * Build a read-only snapshot of the agent's current working set.
 * `recentFileLimit` bounds how many file paths the restore step considers.
 */
export function buildSnapshot(
  sources: SnapshotSources,
  recentFileLimit = 10,
): AgentContextSnapshot {
  return {
    sessionId:   sources.sessionId,
    recentFiles: sources.fileState.recentPaths(recentFileLimit),
    takenAtMs:   Date.now(),
  };
}
