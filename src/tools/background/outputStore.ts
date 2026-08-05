// 把后台进程 stdout/stderr 写入 Session 受控目录，并提供有界游标读取。

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
/** 截断标记写进日志文件本身,裸读文件的人也能看到"到此为止";为它预留字节。 */
const TRUNCATION_NOTICE = '\n[... log truncated ...]\n';
const NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');

export interface BackgroundProcessOutputWriter {
  readonly location: BackgroundProcessOutputLocation;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** 粘性标记:任一流发生过截断后永远为真,不复原。 */
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
  // base64url 解码对脏输入不抛错;格式校验统一落在正则与安全整数检查。
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const match = /^(\d+):(\d+)$/.exec(decoded);
  const stdoutOffset = match ? Number(match[1]) : NaN;
  const stderrOffset = match ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(stdoutOffset) || !Number.isSafeInteger(stderrOffset)) {
    throw new BackgroundProcessError('invalid_cursor', 'Invalid background process output cursor');
  }
  return { stdoutOffset, stderrOffset };
}

// 正文封顶为 MAX - NOTICE_BYTES,给截断标记留位;标记追加后物理文件仍不超 MAX。
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
  // 文件不存在、为空或恰好被清理时统一按空文件处理;不能用 existsSync + statSync
  // 两步——两次系统调用之间文件可能被删,裸 statSync 会把竞态抛成异常。
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
    // 游标不越过它,下一次读取补齐;只有进程终态后才把残尾原样交付。
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

/**
 * 返回 buffer 前 limit 字节内按完整 UTF-8 字符截断后的安全长度。
 *
 * UTF-8 的字节分两类,靠最高位的固定前缀区分:
 * - 续字节(多字节字符的尾巴)永远是 10xxxxxx;
 * - 起始字节用最高位连续 1 的个数声明该字符总长度:
 *   0xxxxxxx(1 字节,即 ASCII)、110xxxxx(2)、1110xxxx(3)、11110xxxx(4)。
 *   所以判断长度只需跟一组递增阈值比大小:<0b1000_0000 则最高位是 0,
 *   <0b1110_0000 则最高两位是 11 但第三位是 0(即 110),依此类推。
 *
 * @example 续字节判定:掩码只保留最高两位再比较。以 "你"(E4 BD A0)为例逐位验算:
 * //   E4          = 1110_0100
 * //   & 1100_0000  = 1100_0000  → 不等于,不是续字节(是起始字节)
 * //   E4          = 1110_0100 中有连续三位 1,声明 3 字节长度
 * 
 * //   BD          = 1011_1101
 * //   & 1100_0000  = 1000_0000  → 等于 0b1000_0000,是续字节
 *
 * 截断规则:从 limit 边界往回跳过全部续字节,找到最后那个起始字节,
 * 它声明的长度完整落在 limit 内 → 保留 limit;跨界 → 砍在该字符之前。
 * 全程只做位运算,不真正解码;畸形输入(起始字节也不合法)按 1 字节
 * 宽容处理,一路回退到头仍找不到起始字节时原样返回 limit。
 *
 * @example buffer = [0x61, E4, BD, A0, 0x61](即 "a你a"):
 * // limit = 2 → 起始字节 E4 在 index 1,声明 3 字节,1+3 > 2 → 返回 1(只留 "a")
 * // limit = 4 → 1+3 ≤ 4 → 返回 4(完整保留 "a你")
 */
function completeUtf8PrefixLength(buffer: Buffer, limit: number): number {
  if (limit <= 0) return 0;
  let lead = limit - 1;
  while (lead >= 0 && (buffer[lead]! & 0b1100_0000) === 0b1000_0000) {
    lead -= 1;
  }
  if (lead < 0) return limit;

  const first = buffer[lead]!;
  const expected = first < 0b1000_0000
    ? 1
    : first < 0b1110_0000
      ? 2
      : first < 0b1111_0000
        ? 3
        : first < 0b1111_1000
          ? 4
          : 1;
  return lead + expected <= limit ? limit : lead;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
