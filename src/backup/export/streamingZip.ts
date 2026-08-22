// 把文件条目逐块压入一个 ZIP，并按输出端的完成或失败语义收尾。
import { Zip, ZipDeflate } from 'fflate';
import type { BackupOutput } from '../types.js';

const MAX_ZIP_ENTRIES = 60_000;

export interface ZipEntry {
  readonly path: string;
  chunks(): AsyncIterable<Uint8Array>;
}

export async function writeStreamingZip(
  entries: AsyncIterable<ZipEntry>,
  output: BackupOutput,
  signal?: AbortSignal,
): Promise<void> {
  let write = Promise.resolve();
  let writeError: unknown;
  let zipError: unknown;
  let count = 0;
  const zip = new Zip((error, chunk) => {
    if (error) {
      zipError ??= error;
      return;
    }
    if (chunk.byteLength === 0) return;
    write = write.then(() => output.write(chunk)).catch((error) => {
      writeError ??= error;
    });
  });

  try {
    for await (const entry of entries) {
      throwIfCancelled(signal);
      count += 1;
      if (count > MAX_ZIP_ENTRIES) throw new Error('ZIP 条目数超过格式上限');
      const file = new ZipDeflate(entry.path, { level: 6 });
      zip.add(file);
      for await (const chunk of entry.chunks()) {
        throwIfCancelled(signal);
        file.push(chunk);
        await flush();
      }
      file.push(new Uint8Array(), true);
      await flush();
    }
    zip.end();
    await flush();
    await output.complete();
  } catch (error) {
    zip.terminate();
    await write;
    await output.fail(error);
    throw error;
  }

  async function flush(): Promise<void> {
    await write;
    if (zipError !== undefined) throw zipError;
    if (writeError !== undefined) throw writeError;
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Session 导出已取消');
}
