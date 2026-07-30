// 把后台进程 stdout/stderr 写入 Session 受控目录，并提供有界游标读取。

import fs from 'node:fs';
import path from 'node:path';
import type { CommandOutputChunk } from '@ema-agent/sandbox';
import type {
  BackgroundProcessOutputLocation,
  BackgroundProcessOutputPathFactory,
} from './types.js';

const STDOUT_FILE = 'stdout.log';
const STDERR_FILE = 'stderr.log';
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const READ_BYTES_PER_STREAM = 64 * 1024;

export interface BackgroundProcessOutputWriter {
  readonly location: BackgroundProcessOutputLocation;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
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

    return {
      location,
      get stdoutBytes() { return stdoutBytes; },
      get stderrBytes() { return stderrBytes; },
      get truncated() { return truncated; },
      append(chunk) {
        if (closed) return;
        const buffer = Buffer.from(chunk.data);
        const written = chunk.stream === 'stdout'
          ? appendBounded(stdoutFd, buffer, stdoutBytes)
          : appendBounded(stderrFd, buffer, stderrBytes);
        if (chunk.stream === 'stdout') stdoutBytes += written;
        else stderrBytes += written;
        if (written < buffer.byteLength) truncated = true;
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
    );
    const stderr = readRange(
      path.join(location.absoluteDirectory, STDERR_FILE),
      cursor.stderrOffset,
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
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const match = /^(\d+):(\d+)$/.exec(decoded);
    if (!match) throw new Error('invalid cursor');
    const stdoutOffset = Number(match[1]);
    const stderrOffset = Number(match[2]);
    if (!Number.isSafeInteger(stdoutOffset) || !Number.isSafeInteger(stderrOffset)) {
      throw new Error('invalid cursor');
    }
    return { stdoutOffset, stderrOffset };
  } catch {
    throw new Error('Invalid background process output cursor');
  }
}

function appendBounded(fd: number, data: Buffer, currentBytes: number): number {
  const remaining = Math.max(0, MAX_STREAM_BYTES - currentBytes);
  if (remaining === 0) return 0;
  const safeLength = remaining < data.byteLength
    ? completeUtf8PrefixLength(data, remaining)
    : data.byteLength;
  const slice = data.subarray(0, safeLength);
  return fs.writeSync(fd, slice);
}

function readRange(filePath: string, offset: number): {
  text: string;
  nextOffset: number;
  hasMore: boolean;
} {
  if (!fs.existsSync(filePath)) {
    return { text: '', nextOffset: offset, hasMore: false };
  }
  const size = fs.statSync(filePath).size;
  const safeOffset = Math.min(Math.max(offset, 0), size);
  const count = Math.min(READ_BYTES_PER_STREAM, size - safeOffset);
  if (count === 0) {
    return { text: '', nextOffset: safeOffset, hasMore: false };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(count);
    const bytesRead = fs.readSync(fd, buffer, 0, count, safeOffset);
    const safeBytes = safeOffset + bytesRead < size
      ? completeUtf8PrefixLength(buffer, bytesRead)
      : bytesRead;
    return {
      text: buffer.subarray(0, safeBytes).toString('utf8'),
      nextOffset: safeOffset + safeBytes,
      hasMore: safeOffset + safeBytes < size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

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
