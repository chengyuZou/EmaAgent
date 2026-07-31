// 测试 Session 导出的流式背压、完整性清单、路径白名单与失败回滚。
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { BACKUP_LIMITS } from '../limits.js';
import { exportPreparedSession } from '../export/sessionExport.js';
import type { BackupOutputSink } from '../types.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function memorySink(): BackupOutputSink & {
  readonly chunks: Uint8Array[];
  readonly commit: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
} {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write: async (chunk) => {
      chunks.push(new Uint8Array(chunk));
    },
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe('Session ZIP 流式导出', () => {
  it('逐块写出记录和文件，并为 manifest 在内的条目生成 SHA-256', async () => {
    const sink = memorySink();
    await exportPreparedSession({
      manifest: {
        format: 'ema-session',
        version: 2,
        sessionId: 'session-1',
        exportedAt: 123,
        generator: 'test',
        warnings: [],
      },
      async *entries() {
        yield {
          path: 'records/session.json',
          async *chunks() {
            yield encoder.encode('{"id":"session-1"}');
          },
        };
        yield {
          path: 'files/attachments/attachment-1/a.txt',
          async *chunks() {
            yield encoder.encode('hello ');
            yield encoder.encode('world');
          },
        };
      },
    }, sink, BACKUP_LIMITS);

    expect(sink.commit).toHaveBeenCalledOnce();
    expect(sink.abort).not.toHaveBeenCalled();
    const files = unzipSync(joined(sink.chunks));
    expect(decoder.decode(files['files/attachments/attachment-1/a.txt'])).toBe('hello world');

    const integrity = JSON.parse(decoder.decode(files['integrity/sha256.json'])) as {
      entries: Array<{ path: string; sha256: string; size: number }>;
    };
    expect(integrity.entries.map((entry) => entry.path)).toEqual([
      'records/session.json',
      'files/attachments/attachment-1/a.txt',
      'manifest.json',
    ]);
    const attachment = integrity.entries[1]!;
    expect(attachment.size).toBe(11);
    expect(attachment.sha256).toBe(createHash('sha256').update('hello world').digest('hex'));
  });

  it('拒绝白名单外路径并 abort，绝不 commit 半包', async () => {
    const sink = memorySink();
    await expect(exportPreparedSession({
      manifest: {
        format: 'ema-session',
        version: 2,
        sessionId: 'session-1',
        exportedAt: 123,
        generator: 'test',
        warnings: [],
      },
      async *entries() {
        yield {
          path: '../profile.db',
          async *chunks() {
            yield new Uint8Array([1]);
          },
        };
      },
    }, sink, BACKUP_LIMITS)).rejects.toThrow('路径非法');
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(sink.commit).not.toHaveBeenCalled();
  });

  it('Sink 写失败时 abort 且不 commit', async () => {
    const sink = memorySink();
    sink.write = async () => {
      throw new Error('disk full');
    };
    await expect(exportPreparedSession({
      manifest: {
        format: 'ema-session',
        version: 2,
        sessionId: 'session-1',
        exportedAt: 123,
        generator: 'test',
        warnings: [],
      },
      async *entries() {
        yield {
          path: 'records/session.json',
          async *chunks() {
            yield encoder.encode('{}');
          },
        };
      },
    }, sink, BACKUP_LIMITS)).rejects.toThrow('disk full');
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(sink.commit).not.toHaveBeenCalled();
  });
});
