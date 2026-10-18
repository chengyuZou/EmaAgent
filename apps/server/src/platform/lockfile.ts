import fs from 'node:fs';
import os from 'node:os';
import { lockfilePath } from './paths.js';

const STALE_MS = 5 * 60 * 1000;     // 超过此时长允许重新认领, 不代表已经证明旧进程退出
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
      /** 当前阻止启动的锁记录, 用于报告占用进程. */
      conflict: LockInfo;
    };

/**
 * 锁记录放在当前 Profile 的 lockfile.json. 未过期且持有者未退出时,
 * 同一 dataDir 的其他进程会被拒绝; 其余情况写入当前进程记录.
 * 每分钟刷新 updatedAt, 关闭时调用 release(); 文件已被别的进程接管时不删除它.
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
 * 持有者进程是否可证明已退出.`process.kill(pid, 0)` 不发信号只探活,
 * ESRCH = 进程已死.仅同主机有效,跨主机锁回退到时间过期判断.
 * 这让热重载(旧 pid 已死)不必等满 5 分钟过期窗口即可回收锁.
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
