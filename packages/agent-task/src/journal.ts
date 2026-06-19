import * as fs   from 'node:fs';
import * as path from 'node:path';
import type { TaskJournalEntry } from './types.js';

// ── TranscriptJournal ─────────────────────────────────────────────────────────
//
// Append-only JSONL file: one TaskJournalEntry per line.
// Every append is a synchronous write so the record lands on disk before the
// caller's next await — no event is silently lost on process kill.
//
// Layout (mirrors Claude Code's subagent transcript paths):
//   {dataDir}/.ema-agent/sessions/{sessionId}/tasks/{taskId}.jsonl

export class TranscriptJournal {
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(entry: TaskJournalEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }

  /** Read all entries. Returns [] if the file doesn't exist or is corrupt. */
  readAll(): TaskJournalEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const entries: TaskJournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as TaskJournalEntry);
      } catch {
        // corrupt line — skip, don't break recovery
      }
    }
    return entries;
  }

  get path(): string { return this.filePath; }
}

// ── journalPathFor ────────────────────────────────────────────────────────────

export function journalPathFor(dataDir: string, sessionId: string, taskId: string): string {
  return path.join(dataDir, '.ema-agent', 'sessions', sessionId, 'tasks', `${taskId}.jsonl`);
}
