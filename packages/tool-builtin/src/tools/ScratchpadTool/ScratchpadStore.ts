// 这里负责串行化共享便笺操作，并用原子文件替换保证配额和内容不会被并发写坏。
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const SCRATCHPAD_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_SCRATCHPAD_VALUE_BYTES = 256 * 1024;
export const MAX_SCRATCHPAD_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_SCRATCHPAD_KEYS = 64;

const META_FILE = '.meta.json';
const operationQueues = new Map<string, Promise<void>>();

type MetaStore = Record<string, { author: string }>;

export interface ScratchpadStoredEntry {
  key: string;
  bytes: number;
  author: string;
}

export interface WriteScratchpadEntryInput {
  dir: string;
  key: string;
  value: string;
  append: boolean;
  author: string;
  signal?: AbortSignal;
}

/** 在目录级锁内重新读取真实状态、检查配额并提交完整的新值。 */
export async function writeScratchpadEntry(
  input: WriteScratchpadEntryInput,
): Promise<{ value: string; bytes: number }> {
  return withScratchpadLock(input.dir, async () => {
    throwIfAborted(input.signal);
    await fs.mkdir(input.dir, { recursive: true });

    const existing = await readRegularUtf8(keyPath(input.dir, input.key));
    const finalValue = input.append && existing
      ? `${existing}\n${input.value}`
      : input.value;
    const finalBytes = Buffer.byteLength(finalValue, 'utf8');

    if (finalBytes > MAX_SCRATCHPAD_VALUE_BYTES) {
      throw new Error(
        `Value would use ${formatBytes(finalBytes)}, exceeding the ` +
        `${formatBytes(MAX_SCRATCHPAD_VALUE_BYTES)} per-key limit.`,
      );
    }

    const entries = await listRegularEntries(input.dir);
    const previous = entries.find((entry) => entry.key === input.key);
    if (!previous && entries.length >= MAX_SCRATCHPAD_KEYS) {
      throw new Error(`Too many scratchpad keys (max ${MAX_SCRATCHPAD_KEYS}). Delete unused keys first.`);
    }

    const usedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const projectedBytes = usedBytes - (previous?.bytes ?? 0) + finalBytes;
    if (projectedBytes > MAX_SCRATCHPAD_TOTAL_BYTES) {
      throw new Error(
        `Turn scratchpad quota exceeded: writing this value would use ${formatBytes(projectedBytes)} ` +
        `(max ${formatBytes(MAX_SCRATCHPAD_TOTAL_BYTES)}). Delete unused keys first.`,
      );
    }

    throwIfAborted(input.signal);
    await atomicWriteUtf8(keyPath(input.dir, input.key), finalValue);

    // 作者信息只用于展示，不影响内容正确性。内容已提交后元数据写入失败时，
    // 保留完整内容并让读取端回退到 main，避免把成功副作用误报成可安全重试。
    try {
      const meta = await readMeta(input.dir);
      meta[input.key] = { author: input.author };
      await atomicWriteUtf8(path.join(input.dir, META_FILE), JSON.stringify(meta));
    } catch {
      // 元数据是非关键投影，下一次成功写入会重新生成。
    }

    return { value: finalValue, bytes: finalBytes };
  });
}

export async function readScratchpadEntry(dir: string, key: string): Promise<string | null> {
  return withScratchpadLock(dir, () => readRegularUtf8(keyPath(dir, key)));
}

export async function listScratchpadEntries(dir: string): Promise<ScratchpadStoredEntry[]> {
  return withScratchpadLock(dir, async () => {
    const entries = await listRegularEntries(dir);
    const meta = await readMeta(dir);
    return entries.map((entry) => ({
      ...entry,
      author: meta[entry.key]?.author ?? 'main',
    }));
  });
}

export async function deleteScratchpadEntry(dir: string, key: string): Promise<boolean> {
  return withScratchpadLock(dir, async () => {
    const target = keyPath(dir, key);
    if (!(await isRegularFile(target))) return false;
    await fs.rm(target, { force: true });

    try {
      const meta = await readMeta(dir);
      if (key in meta) {
        delete meta[key];
        await atomicWriteUtf8(path.join(dir, META_FILE), JSON.stringify(meta));
      }
    } catch {
      // 删除内容已经成功，陈旧作者信息不会被列表返回。
    }
    return true;
  });
}

export async function clearScratchpad(dir: string): Promise<number> {
  return withScratchpadLock(dir, async () => {
    const entries = await listRegularEntries(dir);
    let cleared = 0;
    for (const entry of entries) {
      try {
        await fs.rm(keyPath(dir, entry.key), { force: true });
        cleared++;
      } catch {
        // 继续清理其他 key，返回实际成功数量。
      }
    }
    await fs.rm(path.join(dir, META_FILE), { force: true }).catch(() => undefined);
    return cleared;
  });
}

async function listRegularEntries(dir: string): Promise<Array<{ key: string; bytes: number }>> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const entries: Array<{ key: string; bytes: number }> = [];
  for (const key of names) {
    if (!SCRATCHPAD_KEY_RE.test(key)) continue;
    try {
      const stat = await fs.lstat(keyPath(dir, key));
      if (stat.isFile()) entries.push({ key, bytes: stat.size });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return entries;
}

async function readMeta(dir: string): Promise<MetaStore> {
  const raw = await readRegularUtf8(path.join(dir, META_FILE));
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: MetaStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SCRATCHPAD_KEY_RE.test(key) || !value || typeof value !== 'object') continue;
      const author = (value as { author?: unknown }).author;
      if (typeof author === 'string') result[key] = { author };
    }
    return result;
  } catch {
    return {};
  }
}

async function readRegularUtf8(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.lstat(filePath)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function atomicWriteUtf8(targetPath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.ema-scratchpad-${path.basename(targetPath)}-${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withScratchpadLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const key = comparisonKey(path.resolve(dir));
  const previous = operationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  operationQueues.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (operationQueues.get(key) === tail) operationQueues.delete(key);
  }
}

function keyPath(dir: string, key: string): string {
  return path.join(dir, key);
}

function comparisonKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Scratchpad operation aborted.');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
