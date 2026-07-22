import * as fs   from 'node:fs';
import * as path from 'node:path';

// ── ToolResultCleaner ─────────────────────────────────────────────────────────
//
// Sweeps offloaded tool-result files across all sessions. Tool-result files
// are disposable caches — the message history keeps a preview, so deleting
// them never breaks conversation integrity (read() degrades gracefully).
//
// Three rules, applied in order during sweep():
//   1. TTL          — files older than `ttlDays` are removed.
//   2. Per-session  — a session's total > `perSessionMaxBytes` → delete oldest.
//   3. Global       — all sessions total > `globalMaxBytes` → delete oldest.
//
// Called periodically by the host (apps/core background tick), NOT on a timer
// owned by this package.

export interface CleanerConfig {
  ttlDays:            number;
  perSessionMaxBytes: number;
  globalMaxBytes:     number;
}

export const DEFAULT_CLEANER_CONFIG: CleanerConfig = {
  ttlDays:            7,
  perSessionMaxBytes: 50  * 1024 * 1024,   // 50 MB
  globalMaxBytes:     500 * 1024 * 1024,   // 500 MB
};

interface FileEntry {
  fullPath: string;
  size:     number;
  mtimeMs:  number;
}

export class ToolResultCleaner {
  /** @param sessionsDir absolute path: {dataDir}/.ema-agent/sessions */
  constructor(
    private readonly sessionsDir: string,
    private readonly config: CleanerConfig = DEFAULT_CLEANER_CONFIG,
  ) {}

  /** Run all cleanup rules. Returns count of deleted files. Fully tolerant. */
  sweep(): { deleted: number; freedBytes: number } {
    let deleted = 0;
    let freed   = 0;

    const sessionDirs = this.listSessionToolResultDirs();
    const allFiles: FileEntry[] = [];
    const now = Date.now();
    const ttlMs = this.config.ttlDays * 24 * 60 * 60 * 1000;

    for (const dir of sessionDirs) {
      const files = this.listFiles(dir);

      // Rule 1: TTL — but skip sessions with recent activity. A long-running
      // session shouldn't lose its early tool results just because they aged
      // past ttlDays while the session is still in use; the session directory's
      // mtime is the activity signal (any write into the session dir updates
      // it). Quota rules below still apply to active sessions, so disk usage
      // stays bounded.
      const sessionDir = path.dirname(dir);
      let sessionActive = false;
      try {
        sessionActive = (now - fs.statSync(sessionDir).mtimeMs) < ttlMs;
      } catch { /* session dir gone — treat as inactive */ }

      const survivors: FileEntry[] = [];
      for (const f of files) {
        if (!sessionActive && now - f.mtimeMs > ttlMs) {
          if (this.rm(f.fullPath)) { deleted++; freed += f.size; }
        } else {
          survivors.push(f);
        }
      }

      // Rule 2: per-session quota (delete oldest first)
      const r2 = this.enforceQuota(survivors, this.config.perSessionMaxBytes);
      deleted += r2.deleted; freed += r2.freedBytes;
      allFiles.push(...r2.remaining);
    }

    // Rule 3: global quota (delete oldest across all sessions)
    const r3 = this.enforceQuota(allFiles, this.config.globalMaxBytes);
    deleted += r3.deleted; freed += r3.freedBytes;

    return { deleted, freedBytes: freed };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private enforceQuota(files: FileEntry[], maxBytes: number): {
    deleted: number; freedBytes: number; remaining: FileEntry[];
  } {
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= maxBytes) return { deleted: 0, freedBytes: 0, remaining: files };

    // Oldest first
    const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    const remaining: FileEntry[] = [];
    let deleted = 0;
    let freed   = 0;
    for (const f of sorted) {
      if (total > maxBytes && this.rm(f.fullPath)) {
        deleted++; freed += f.size; total -= f.size;
      } else {
        remaining.push(f);
      }
    }
    return { deleted, freedBytes: freed, remaining };
  }

  private listSessionToolResultDirs(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return []; // sessions dir doesn't exist yet
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(this.sessionsDir, e.name, 'tool-results'))
      .filter((d) => fs.existsSync(d));
  }

  private listFiles(dir: string): FileEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: FileEntry[] = [];
    for (const name of names) {
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) out.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch { /* file vanished — skip */ }
    }
    return out;
  }

  private rm(fullPath: string): boolean {
    try {
      fs.rmSync(fullPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
