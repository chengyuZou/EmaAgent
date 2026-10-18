import fs from 'node:fs';
import path from 'node:path';
import type { CommandOutputChunk } from '@ema-agent/sandbox';
import { BackgroundProcessError } from '../errors.js';
import type {
  BackgroundProcessOutputLocation,
  BackgroundProcessOutputPathFactory,
} from './types.js';

const STDOUT_FILE = 'stdout.log';
const STDERR_FILE = 'stderr.log';
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const READ_BYTES_PER_STREAM = 64 * 1024;
/** 截断标记写进日志文件本身,裸读文件的人也能看到"到此为止";为它预留字节. */
const TRUNCATION_NOTICE = '\n[... log truncated ...]\n';
const NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');

export interface BackgroundProcessOutputWriter {
  readonly location: BackgroundProcessOutputLocation;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** 粘性标记:任一流发生过截断后永远为真,不复原. */
  readonly truncated: boolean;
  append(chunk: CommandOutputChunk): void;
  close(): void;
}

export class BackgroundProcessOutputStore {
  constructor(private readonly createLocation: BackgroundProcessOutputPathFactory) {}

  create(
    sessionId: Parameters<BackgroundProcessOutputPathFactory>[0],
    processId: Parameters<BackgroundProcessOutputPathFactory>[1],
  ): BackgroundProcessOutputWriter {
    const location = this.createLocation(sessionId, processId);
    fs.mkdirSync(location.absoluteDirectory, { recursive: true });
    const stdoutPath = path.join(location.absoluteDirectory, STDOUT_FILE);
    const stderrPath = path.join(location.absoluteDirectory, STDERR_FILE);
    const stdoutFd = fs.openSync(stdoutPath, 'a');
    const stderrFd = fs.openSync(stderrPath, 'a');
    let stdoutBytes = fileSize(stdoutPath);
    let stderrBytes = fileSize(stderrPath);
    let truncated = false;
    let closed = false;
    let stdoutNoticeWritten = false;
    let stderrNoticeWritten = false;

    return {
      location,
      get stdoutBytes() { return stdoutBytes; },
      get stderrBytes() { return stderrBytes; },
      get truncated() { return truncated; },
      append(chunk) {
        if (closed) return;
        const buffer = Buffer.from(chunk.data);
        if (chunk.stream === 'stdout') {
          const written = appendBounded(stdoutFd, buffer, stdoutBytes);
          stdoutBytes += written;
          if (written < buffer.byteLength) {
            if (!stdoutNoticeWritten) {
              stdoutBytes += fs.writeSync(stdoutFd, TRUNCATION_NOTICE);
              stdoutNoticeWritten = true;
            }
            truncated = true;
          }
          return;
        }
        const written = appendBounded(stderrFd, buffer, stderrBytes);
        stderrBytes += written;
        if (written < buffer.byteLength) {
          if (!stderrNoticeWritten) {
            stderrBytes += fs.writeSync(stderrFd, TRUNCATION_NOTICE);
            stderrNoticeWritten = true;
          }
          truncated = true;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
      },
    };
  }

  remove(location: BackgroundProcessOutputLocation): void {
    fs.rmSync(location.absoluteDirectory, { recursive: true, force: true });
  }

  read(
    location: BackgroundProcessOutputLocation,
    cursor: { stdoutOffset: number; stderrOffset: number },
    mayGrow: boolean,
  ): {
    stdout: string;
    stderr: string;
    stdoutOffset: number;
    stderrOffset: number;
    hasMore: boolean;
  } {
    const stdout = readRange(
      path.join(location.absoluteDirectory, STDOUT_FILE),
      cursor.stdoutOffset,
      mayGrow,
    );
    const stderr = readRange(
      path.join(location.absoluteDirectory, STDERR_FILE),
      cursor.stderrOffset,
      mayGrow,
    );
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutOffset: stdout.nextOffset,
      stderrOffset: stderr.nextOffset,
      hasMore: stdout.hasMore || stderr.hasMore,
    };
  }
}

export function encodeOutputCursor(cursor: {
  stdoutOffset: number;
  stderrOffset: number;
}): string {
  return Buffer.from(`${cursor.stdoutOffset}:${cursor.stderrOffset}`, 'utf8')
    .toString('base64url');
}

export function decodeOutputCursor(value?: string): {
  stdoutOffset: number;
  stderrOffset: number;
} {
  if (!value) return { stdoutOffset: 0, stderrOffset: 0 };
  // base64url 解码对脏输入不抛错;格式校验统一落在正则与安全整数检查.
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const match = /^(\d+):(\d+)$/.exec(decoded);
  const stdoutOffset = match ? Number(match[1]) : NaN;
  const stderrOffset = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(stdoutOffset) || !Number.isSafeInteger(stderrOffset)) {
    throw new BackgroundProcessError('invalid_cursor', 'Invalid background process output cursor');
  }
  return { stdoutOffset, stderrOffset };
}

// 正文封顶为 MAX - NOTICE_BYTES,给截断标记留位;标记追加后物理文件仍不超 MAX.
function appendBounded(fd: number, data: Buffer, currentBytes: number): number {
  const remaining = Math.max(0, MAX_STREAM_BYTES - NOTICE_BYTES - currentBytes);
  if (remaining === 0) return 0;
  const safeLength = remaining < data.byteLength
    ? completeUtf8PrefixLength(data, remaining)
    : data.byteLength;
  const slice = data.subarray(0, safeLength);
  return fs.writeSync(fd, slice);
}

function readRange(filePath: string, offset: number, mayGrow: boolean): {
  text: string;
  nextOffset: number;
  hasMore: boolean;
} {
  // 大小查询失败时按空文件处理. 读取仍可能因文件在 openSync 前被删除而失败.
  const size = fileSize(filePath);
  if (size === 0) {
    return { text: '', nextOffset: offset, hasMore: false };
  }
  const safeOffset = Math.min(Math.max(offset, 0), size);
  const count = Math.min(READ_BYTES_PER_STREAM, size - safeOffset);
  if (count === 0) {
    return { text: '', nextOffset: safeOffset, hasMore: false };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(count);
    const bytesRead = fs.readSync(fd, buffer, 0, count, safeOffset);
    // 未到文件尾时末尾可能切在多字节字符中间,按完整字符回退;
    // 进程仍活着(mayGrow)时,当前文件尾同样可能只是半个字符刚落盘——也回退扣下,
    // 游标不越过它,下一次读取补齐;只有进程终态后才把残尾原样交付.
    const atEnd = safeOffset + bytesRead >= size;
    const safeBytes = atEnd && !mayGrow
      ? bytesRead
      : completeUtf8PrefixLength(buffer, bytesRead);
    return {
      text: buffer.subarray(0, safeBytes).toString('utf8'),
      nextOffset: safeOffset + safeBytes,
      hasMore: safeOffset + safeBytes < size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 从边界回看最后一个 UTF-8 起始字节, 不返回尚未写完的多字节字符. 畸形输入不在这里修复. */
function completeUtf8PrefixLength(buffer: Buffer, limit: number): number {
  if (limit <= 0) return 0;
  let lead = limit - 1;
  while (lead >= 0 && (buffer[lead]! & 0b1100_0000) === 0b1000_0000) {
    lead -= 1;
  }
  if (lead < 0) return limit;

  const first = buffer[lead]!;
  let expected = 1;
  if (first >= 0b1000_0000 && first < 0b1110_0000) {
    expected = 2;
  } else if (first >= 0b1110_0000 && first < 0b1111_0000) {
    expected = 3;
  } else if (first >= 0b1111_0000 && first < 0b1111_1000) {
    expected = 4;
  }
  return lead + expected <= limit ? limit : lead;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
