// 向桌面宿主原子发布 Core 的 PID、端口、nonce 与协议版本握手。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RUNTIME_PROTOCOL_VERSION = 1;

export function publishRuntimeReady(port: number): (() => void) | null {
  const readyFile = process.env['EMA_READY_FILE'];
  const nonce = process.env['EMA_RUNTIME_NONCE'];
  if (!readyFile || !nonce) return null;

  const configuredProtocol = Number(process.env['EMA_RUNTIME_PROTOCOL_VERSION'] ?? RUNTIME_PROTOCOL_VERSION);
  if (configuredProtocol !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `runtime protocol mismatch: host=${configuredProtocol}, core=${RUNTIME_PROTOCOL_VERSION}`,
    );
  }

  mkdirSync(path.dirname(readyFile), { recursive: true });
  const temporaryFile = `${readyFile}.${process.pid}.tmp`;
  const record = {
    service: 'core',
    pid: process.pid,
    port,
    nonce,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    startedAt: Date.now(),
  };
  writeFileSync(temporaryFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryFile, readyFile);

  return () => {
    rmSync(readyFile, { force: true });
    rmSync(temporaryFile, { force: true });
  };
}
