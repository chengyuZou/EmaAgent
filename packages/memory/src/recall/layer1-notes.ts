import type { SessionId } from '@ema-agent/contracts';
import type { MemoryDeps } from '../deps.js';

/**
 * Layer-1 recall: load the session's current summary note.
 * Returns null when no row exists yet (first turn of the session).
 */
export function recallSessionNote(deps: MemoryDeps, sessionId: SessionId): string | null {
  const row = deps.sessionNotes.findBySession(sessionId);
  if (!row || row.body.trim() === '') return null;
  return row.body;
}
