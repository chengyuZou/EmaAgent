import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  truncateSync, unlinkSync, utimesSync, writeFileSync, WriteStream,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { FileLogWriter } from '../fileWriter.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    lstatSync: vi.fn(original.lstatSync),
    unlinkSync: vi.fn(original.unlinkSync),
  };
});

const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const directories: string[] = [];
const writers: FileLogWriter[] = [];

function directory(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'ema-log-files-'));
  directories.push(value);
  return value;
}

function open(directory: string): FileLogWriter {
  const writer = new FileLogWriter(directory);
  writers.push(writer);
  return writer;
}

function logs(directory: string): string[] {
  return readdirSync(directory).filter(name => /^ema-.*\.log$/.test(name));
}

afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.close();
  vi.restoreAllMocks();
  vi.mocked(lstatSync).mockReset().mockImplementation(originalFs.lstatSync);
  vi.mocked(unlinkSync).mockReset().mockImplementation(originalFs.unlinkSync);
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    expect(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(resolved).startsWith('ema-log-files-')).toBe(true);
    rmSync(resolved, { recursive: true, force: true });
  }
});

it('关闭前保存 UTF-8 正文, 拥堵期间计数丢弃并在关闭时留下说明', async () => {
  const root = directory();
  const writer = open(root);
  for (let index = 0; index < 1000; index += 1) {
    writer.write(`${JSON.stringify({ index, message: '中文😀'.repeat(300) })}\n`);
  }
  expect(await writer.close()).toBe(true);
  const lines = logs(root).flatMap(name => readFileSync(path.join(root, name), 'utf8').trim().split('\n'));
  const rows = lines.map(line => JSON.parse(line));
  expect(rows[0].message).toContain('中文😀');
  const summary = rows.find(row => row.event === 'logging.dropped');
  expect(summary.body.count).toBeGreaterThan(0);
  expect(rows.filter(row => row.index !== undefined).length + summary.body.count).toBe(1000);
});

it('只清理过期或超出容量的日志, 保留无关文件和仍活着的其他进程日志', async () => {
  const root = directory();
  const expired = path.join(root, `ema-1-${process.pid}-0.log`);
  const active = path.join(root, `ema-2-${process.ppid}-0.log`);
  const unrelated = path.join(root, 'personal.log');
  for (const file of [expired, active, unrelated]) {
    writeFileSync(file, 'old');
    utimesSync(file, new Date(0), new Date(0));
  }
  const writer = open(root);
  writer.write('{"message":"saved"}\n');
  expect(await writer.close()).toBe(true);
  expect(readdirSync(root)).not.toContain(path.basename(expired));
  expect(readFileSync(active, 'utf8')).toBe('old');
  expect(readFileSync(unrelated, 'utf8')).toBe('old');
});

it.each([false, true])('容量不足时回收旧日志, 并发删除=%s', async concurrentDeletion => {
  const root = directory();
  const old = path.join(root, `ema-1-${process.pid}-0.log`);
  writeFileSync(old, '');
  truncateSync(old, 100 * 1024 * 1024);
  if (concurrentDeletion) {
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      // 另一进程先删掉文件, 被测的删除操作随后遇到真实的 ENOENT.
      originalFs.unlinkSync(old);
      originalFs.unlinkSync(old);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((_line, _encoding, callback) => {
      if (typeof callback === 'function') callback();
      return true;
    });
  }
  const writer = open(root);
  writer.write('{"message":"saved"}\n');
  expect(await writer.close()).toBe(true);
  expect(logs(root)).not.toContain(path.basename(old));
});

it('目录枚举后文件被并发删除, 仍能保存后续日志', async () => {
  const root = directory();
  const disappearingFile = path.join(root, `ema-1-${process.pid}-0.log`);
  writeFileSync(disappearingFile, 'old');
  vi.mocked(lstatSync).mockImplementationOnce(() => {
    originalFs.unlinkSync(disappearingFile);
    return originalFs.lstatSync(disappearingFile);
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((_line, _encoding, callback) => {
    if (typeof callback === 'function') callback();
    return true;
  });

  const writer = open(root);
  writer.write('{"message":"first"}\n');
  writer.write('{"message":"still writing"}\n');
  expect(await writer.close()).toBe(true);
  const rows = logs(root).flatMap(name => readFileSync(path.join(root, name), 'utf8').trim().split('\n'));
  expect(rows.map(line => JSON.parse(line).message)).toEqual(['first', 'still writing']);
  expect(stderr).not.toHaveBeenCalled();
});

it('读取日志元数据的权限错误不会被当成文件已删除而吞掉', async () => {
  const root = directory();
  writeFileSync(path.join(root, `ema-1-${process.pid}-0.log`), 'old');
  vi.mocked(lstatSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('metadata access denied'), { code: 'EACCES' });
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((_line, _encoding, callback) => {
    if (typeof callback === 'function') callback();
    return true;
  });

  const writer = open(root);
  expect(await writer.close()).toBe(false);
  expect(stderr).toHaveBeenCalledOnce();
  expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({
    event: 'logging.file_failed',
    error: { code: 'EACCES' },
  });
});

it('文件到达上限前轮换, 新旧文件关闭后都能读取完整 JSON 行', async () => {
  const root = directory();
  const writer = open(root);
  const line = `${JSON.stringify({ message: 'x'.repeat(8000) })}\n`;
  for (let index = 0; index < 2200 && logs(root).length < 2; index += 1) {
    writer.write(line);
    await delay(1);
  }
  expect(await writer.close()).toBe(true);
  expect(logs(root).length).toBeGreaterThanOrEqual(2);
  for (const name of logs(root)) {
    const filename = path.join(root, name);
    expect(statSync(filename).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    for (const line of readFileSync(filename, 'utf8').trim().split('\n')) JSON.parse(line);
  }
}, 30_000);

it('目录无法创建时不抛入业务调用, 关闭结果明确失败', async () => {
  const root = directory();
  const file = path.join(root, 'not-a-directory');
  writeFileSync(file, 'content');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((_line, _encoding, callback) => {
    if (typeof callback === 'function') callback();
    return true;
  });
  const writer = open(file);
  expect(() => writer.write('{"message":"cannot save"}\n')).not.toThrow();
  expect(await writer.close()).toBe(false);
  expect(stderr).toHaveBeenCalledOnce();
});

it('真实 Node 子进程直接保存业务日志, stdout 不承载日志正文', async () => {
  const root = directory();
  const entry = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    const { initializeLogging, logging, closeLogging, setDiagnosticSecrets } = await import(${JSON.stringify(entry)});
    initializeLogging(process.argv[1]);
    setDiagnosticSecrets(['fake-private-value']);
    logging({ level: 'debug', target: 'speech', event: 'speech.failed',
      message: '中文日志😀', error: new Error('fake-private-value'), body: { turnId: 't1' } });
    const saved = await closeLogging();
    process.stdout.write(JSON.stringify({ saved, pid: process.pid }));
    process.exitCode = saved ? 0 : 1;
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.saved).toBe(true);
  const row = JSON.parse(readFileSync(path.join(root, logs(root)[0]!), 'utf8'));
  expect(row).toMatchObject({ pid: result.pid, level: 'debug', target: 'speech', message: '中文日志😀', body: { turnId: 't1' } });
  expect(row.error.message).toBe('[REDACTED]');
  expect(row.error.stack).toContain('[REDACTED]');
});

it('文件未完成关闭时按期限返回失败, 不无限等待', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation((_line, _encoding, callback) => {
    if (typeof callback === 'function') callback();
    return true;
  });
  vi.spyOn(WriteStream.prototype, 'end').mockImplementation(function (this: WriteStream) {
    return this;
  });
  const writer = open(directory());
  expect(await writer.close(20)).toBe(false);
});
