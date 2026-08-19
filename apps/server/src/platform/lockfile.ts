// Profile 锁文件：防止两个 server 进程同时持有同一个数据目录。
import fs from 'node:fs';
import os from 'node:os';
import { lockfilePath } from './paths.js';

const STALE_MS = 5 * 60 * 1000;     // updatedAt 超过此时长视为已崩溃
const HEARTBEAT_MS = 60 * 1000;     // 运行期间每分钟刷新一次

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
      /** 挡住我们的现存活锁；调用方可展示给用户。 */
      conflict: LockInfo;
    };

/**
 * 为当前（进程, dataDir）认领 `~/.ema-agent/lockfile.json`。
 * 规则：无锁或锁已过期 → 认领；活锁指向不同 dataDir → 认领（不同目录互不干扰）；
 * 活锁同 dataDir 且 pid 不同 → 拒绝并返回冲突；同 pid → 幂等重认领。
 * 成功时返回 release()，优雅关闭时调用；心跳每分钟刷新 updatedAt。
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
    } catch { /* 心跳失败下次再试 */ }
  }, HEARTBEAT_MS);
  timer.unref?.();

  const release = () => {
    clearInterval(timer);
    try {
      const fresh = readLockfile(fp);
      if (fresh && fresh.pid === process.pid) {
        fs.rmSync(fp, { force: true });
      }
    } catch { /* 释放失败不阻断关闭 */ }
  };

  return { acquired: true, release };
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

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
 * 持有者进程是否可证明已退出。`process.kill(pid, 0)` 不发信号只探活，
 * ESRCH = 进程已死。仅同主机有效，跨主机锁回退到时间过期判断。
 * 这让热重载（旧 pid 已死）不必等满 5 分钟过期窗口即可回收锁。
 */
function isHolderDead(info: LockInfo): boolean {
  if (info.hostname !== os.hostname()) return false;
  if (info.pid === process.pid) return false;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
