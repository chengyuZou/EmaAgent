import process from 'node:process';

export function checkAvailableMemory(): number {
  // Windows, macOS 和 Linux 使用同一个 Node 入口. 读取失败向上传播, 不用 0 代替错误.
  const availableBytes = process.availableMemory();
  if (!Number.isFinite(availableBytes) || availableBytes < 0) {
    throw new Error('Available memory reading must be a finite, non-negative byte count.');
  }
  return availableBytes;
}
