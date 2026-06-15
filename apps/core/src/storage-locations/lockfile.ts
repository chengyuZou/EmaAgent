import fs from 'node:fs';
import os from 'node:os';
import { lockfilePath } from './paths.js';

// ── Lockfile ─────────────────────────────────────────────────────────────────

const STALE_MS = 5 * 60 * 1000;     // older than this → considered crashed
const HEARTBEAT_MS = 60 * 1000;     // refresh once per minute while running

export interface LockInfo {
  hostname:   string;
  pid:        number;
  dataDir:    string;
  startedAt:  number;
  updatedAt:  number;
}

export type LockAcquireResult =
  | { acquired: true;  release: () => void }
  | {
      acquired: false;
      /** Existing live lock that blocked us. Caller may show this to the user. */
      conflict: LockInfo;
    };

/**
 * Attempt to claim `~/.ema-agent/lockfile.json` for this (process, dataDir).
 *
 * Rules:
 *   - No lockfile, or stale (>5 min since updatedAt) → claim it.
 *   - Active lock for a DIFFERENT dataDir → claim it (independent dirs are OK).
 *   - Active lock for the SAME dataDir + different pid → reject with conflict.
 *   - Active lock from the same pid → idempotent (re-claim).
 *
 * On success returns a `release` function that should be called on graceful
 * shutdown. A heartbeat refreshes `updatedAt` every minute so a long-running
 * process isn't considered crashed.
 */
export function acquireLock(dataDir: string): LockAcquireResult {
  const fp = lockfilePath();
  const now = Date.now();
  const me: LockInfo = {
    hostname:  os.hostname(),
    pid:       process.pid,
    dataDir,
    startedAt: now,
    updatedAt: now,
  };

  const existing = readLockfile(fp);
  if (
    existing &&
    !isStale(existing, now) &&
    !isHolderDead(existing) &&
    existing.dataDir === dataDir &&
    existing.pid !== process.pid
  ) {
    return { acquired: false, conflict: existing };
  }

  writeLockfile(fp, me);

  const timer = setInterval(() => {
    try {
      const fresh = readLockfile(fp);
      if (!fresh || fresh.pid !== process.pid) {
        clearInterval(timer);
        return;
      }
      writeLockfile(fp, { ...me, updatedAt: Date.now() });
    } catch { /* ignore */ }
  }, HEARTBEAT_MS);
  timer.unref?.();

  const release = () => {
    clearInterval(timer);
    try {
      const fresh = readLockfile(fp);
      if (fresh && fresh.pid === process.pid) {
        fs.rmSync(fp, { force: true });
      }
    } catch { /* ignore */ }
  };

  return { acquired: true, release };
}

// ── Internals ────────────────────────────────────────────────────────────────

function readLockfile(fp: string): LockInfo | null {
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

function writeLockfile(fp: string, info: LockInfo): void {
  fs.writeFileSync(fp, JSON.stringify(info, null, 2), { encoding: 'utf8' });
}

function isStale(info: LockInfo, now: number): boolean {
  return now - info.updatedAt > STALE_MS;
}

/**
 * True when the lock's holder process is provably gone. `process.kill(pid, 0)`
 * sends no signal — it only probes existence, throwing ESRCH for a dead pid.
 * Only meaningful on the SAME host (a pid on another machine tells us nothing),
 * so cross-host locks fall back to the time-based staleness check.
 *
 * This is what makes hot-reload (tsx watch hard-kills + respawns within
 * seconds) and crash recovery work without waiting out the 5-minute window:
 * the old pid is dead → its lock is immediately reclaimable.
 */
function isHolderDead(info: LockInfo): boolean {
  if (info.hostname !== os.hostname()) return false;
  if (info.pid === process.pid) return false;
  try {
    process.kill(info.pid, 0);
    return false;   // signal accepted → process alive
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = alive but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
