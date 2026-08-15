import type { MemoryDeps } from '../deps.js';
import type { SessionNoteEntry } from '../extract/types.js';
import { safeParseEntries } from '../extract/types.js';

/**
 * Layer-1 recall: load the session's current summary note.
 * Returns null when no row exists yet (first turn of the session).
 */
export function recallSessionNote(deps: MemoryDeps, sessionId: string): string | null {
  const row = deps.sessionNotes.findBySession(sessionId);
  if (!row || !row.body.trim()) return null;

  const entries = safeParseEntries(row.body);
  if (entries.length === 0) return null;

  // 渲染成带时间戳的 markdown，注入给模型时有明确的时间轴
  const rendered = entries
    .map(e => {
      const ts = new Date(e.at).toISOString().replace('T', ' ').slice(0, 16);
      return `**[${ts}]**\n${e.delta}`;
    })
    .join('\n\n');
  return rendered;
}

