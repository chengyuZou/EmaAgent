// Server 真正开始监听后，向桌面宿主原子发布实际端口。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 写入 ready 文件并返回清理函数。
 * EMA_READY_FILE 是与 Tauri 宿主共享的跨进程接口，改名必须与 Desktop 同批。
 */
export function publishReadyFile(port: number): (() => void) | null {
  const readyFile = process.env['EMA_READY_FILE'];
  if (!readyFile) return null;

  mkdirSync(path.dirname(readyFile), { recursive: true });
  const temporaryFile = `${readyFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ port }), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryFile, readyFile);

  return () => {
    rmSync(readyFile, { force: true });
    rmSync(temporaryFile, { force: true });
  };
}
