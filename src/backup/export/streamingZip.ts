// 把有界条目逐块压入 ZIP，并把输出背压、预算和 Sink 终态收在同一个位置。
import { Zip, ZipDeflate } from 'fflate';
import type { BackupOutputSink } from '../types.js';

export interface StreamingZipLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxArchiveBytes: number;
}

export interface StreamingZipEntry {
  readonly path: string;
  readonly declaredSize?: number;
  chunks(): AsyncIterable<Uint8Array>;
}

export class StreamingZipLimitError extends Error {
  readonly code = 'backup/export-limit-exceeded';

  constructor(message: string) {
    super(message);
    this.name = 'StreamingZipLimitError';
  }
}

/** 单次实例只允许 commit 或 abort 一次，调用方不能复用已结束的 Writer。 */
export class StreamingZipWriter {
  private readonly zip: Zip;
  private pendingWrite = Promise.resolve();
  private writeError: unknown;
  private entryCount = 0;
  private expandedBytes = 0;
  private archiveBytes = 0;
  private ended = false;
  private aborted = false;

  constructor(
    private readonly sink: BackupOutputSink,
    private readonly limits: StreamingZipLimits,
  ) {
    this.zip = new Zip((error, chunk) => {
      if (error) {
        this.writeError ??= error;
        return;
      }
      if (chunk.byteLength === 0) return;
      this.archiveBytes += chunk.byteLength;
      if (this.archiveBytes > this.limits.maxArchiveBytes) {
        this.writeError ??= new StreamingZipLimitError('ZIP 输出超过归档字节上限');
        this.zip.terminate();
        return;
      }
      this.pendingWrite = this.pendingWrite
        .then(() => this.sink.write(chunk))
        .catch((sinkError) => {
          this.writeError ??= sinkError;
        });
    });
  }

  async add(entry: StreamingZipEntry): Promise<void> {
    this.assertOpen();
    this.entryCount += 1;
    if (this.entryCount > this.limits.maxEntries) {
      throw new StreamingZipLimitError('ZIP 条目数超过上限');
    }
    if (entry.declaredSize !== undefined && entry.declaredSize > this.limits.maxEntryBytes) {
      throw new StreamingZipLimitError(`${entry.path} 超过单条目字节上限`);
    }

    const stream = new ZipDeflate(entry.path, { level: 6 });
    this.zip.add(stream);
    let entryBytes = 0;
    for await (const chunk of entry.chunks()) {
      entryBytes += chunk.byteLength;
      this.expandedBytes += chunk.byteLength;
      this.assertByteBudgets(entry.path, entryBytes);
      stream.push(chunk);
      await this.flushWrites();
    }
    stream.push(new Uint8Array(), true);
    await this.flushWrites();
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.ended = true;
    this.zip.end();
    await this.flushWrites();
    await this.sink.commit();
  }

  async abort(reason: unknown): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    if (!this.ended) {
      this.ended = true;
      this.zip.terminate();
    }
    await this.pendingWrite;
    await this.sink.abort(reason);
  }

  private assertOpen(): void {
    if (this.ended) throw new Error('ZIP Writer 已结束');
  }

  private assertByteBudgets(path: string, entryBytes: number): void {
    if (entryBytes > this.limits.maxEntryBytes) {
      throw new StreamingZipLimitError(`${path} 超过单条目字节上限`);
    }
    if (this.expandedBytes > this.limits.maxExpandedBytes) {
      throw new StreamingZipLimitError('ZIP 展开总字节超过上限');
    }
  }

  private async flushWrites(): Promise<void> {
    await this.pendingWrite;
    if (this.writeError !== undefined) throw this.writeError;
  }
}
