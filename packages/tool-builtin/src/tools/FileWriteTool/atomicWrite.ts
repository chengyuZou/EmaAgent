// 这里负责给 FileWriteTool 加跨 Session 路径锁，并用同目录临时文件完成原子替换。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const writeQueues = new Map<string, Promise<void>>();

export interface AtomicWriteResult {
  targetPath: string;
  existed: boolean;
  previousContent: string | null;
  content: string;
  mtimeMs: number;
}

export interface AtomicTransformState {
  targetPath: string;
  existed: boolean;
  content: string | null;
  mtimeMs: number | null;
}

/** 临时文件名包含调用编号，应用崩溃后可以根据执行日志精确清理。 */
export function atomicTempPrefix(targetPath: string, operationId: string): string {
  const targetHash = shortHash(path.basename(targetPath));
  const operationHash = shortHash(operationId);
  return `.ema-write-${targetHash}-${operationHash}-`;
}

export async function atomicWriteUtf8(
  requestedPath: string,
  content: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<AtomicWriteResult> {
  return atomicTransformUtf8(
    requestedPath,
    operationId,
    signal,
    () => content,
  );
}

/** 在同一条规范路径锁内完成读取、校验、转换和原子替换，避免并发写入穿过检查。 */
export async function atomicTransformUtf8(
  requestedPath: string,
  operationId: string,
  signal: AbortSignal | undefined,
  transform: (state: AtomicTransformState) => string,
  createParent = true,
): Promise<AtomicWriteResult> {
  const targetPath = resolveAtomicTargetPath(requestedPath, createParent);
  const lockKey = comparisonKey(targetPath);

  return withPathLock(lockKey, async () => {
    throwIfAborted(signal);
    const existed = fs.existsSync(targetPath);
    const previousContent = existed ? fs.readFileSync(targetPath, 'utf8') : null;
    const previousMtimeMs = existed ? fs.statSync(targetPath).mtimeMs : null;
    const content = transform({
      targetPath,
      existed,
      content: previousContent,
      mtimeMs: previousMtimeMs,
    });
    throwIfAborted(signal);
    const tempPath = path.join(
      path.dirname(targetPath),
      `${atomicTempPrefix(targetPath, operationId)}${randomUUID()}.tmp`,
    );

    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, content, { encoding: 'utf8' });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      throwIfAborted(signal);
      fs.renameSync(tempPath, targetPath);
      syncParentDirectoryBestEffort(path.dirname(targetPath));
      return {
        targetPath,
        existed,
        previousContent,
        content,
        mtimeMs: fs.statSync(targetPath).mtimeMs,
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* 文件清理仍会继续。 */ }
      }
      try { fs.unlinkSync(tempPath); } catch { /* 文件可能尚未创建或已完成替换。 */ }
      throw error;
    }
  });
}

export function resolveAtomicTargetPath(requestedPath: string, createParent = true): string {
  const absolute = path.resolve(requestedPath);
  const parent = path.dirname(absolute);
  if (createParent) fs.mkdirSync(parent, { recursive: true });

  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    if (!fs.existsSync(parent)) return absolute;
    return path.join(fs.realpathSync.native(parent), path.basename(absolute));
  }
}

async function withPathLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  writeQueues.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  }
}

function comparisonKey(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('文件写入已取消');
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function syncParentDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Windows 等平台可能不允许 fsync 目录；文件本身已经完成 fsync 和 rename。
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 无需覆盖原始写入结果。 */ }
    }
  }
}
