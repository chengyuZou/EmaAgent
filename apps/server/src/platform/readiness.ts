// 向桌面宿主原子发布 server 的 PID、端口、nonce 与协议版本握手。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const READY_PROTOCOL_VERSION = 1;

/**
 * 写入 ready 文件并返回清理函数。
 * service 字段与 EMA_READY_FILE/EMA_RUNTIME_NONCE 环境变量是与 Tauri 宿主共享的
 * 跨进程契约；改名必须与 desktop 批同步（见接力板）。
 */
export function publishReadyFile(port: number): (() => void) | null {
  const readyFile = process.env['EMA_READY_FILE'];
  const nonce = process.env['EMA_RUNTIME_NONCE'];
  if (!readyFile || !nonce) return null;

  const configuredProtocol = Number(process.env['EMA_RUNTIME_PROTOCOL_VERSION'] ?? READY_PROTOCOL_VERSION);
  if (configuredProtocol !== READY_PROTOCOL_VERSION) {
    throw new Error(
      `ready protocol mismatch: host=${configuredProtocol}, server=${READY_PROTOCOL_VERSION}`,
    );
  }

  mkdirSync(path.dirname(readyFile), { recursive: true });
  const temporaryFile = `${readyFile}.${process.pid}.tmp`;
  const record = {
    service: 'server',
    pid: process.pid,
    port,
    nonce,
    protocolVersion: READY_PROTOCOL_VERSION,
    startedAt: Date.now(),
  };
  writeFileSync(temporaryFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryFile, readyFile);

  return () => {
    rmSync(readyFile, { force: true });
    rmSync(temporaryFile, { force: true });
  };
}
