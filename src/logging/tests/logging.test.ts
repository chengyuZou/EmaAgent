import process from 'node:process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logging, setDiagnosticSecrets, closeLogging } from '../index.js';
import { MAX_LOG_BYTES } from '../internal/limit.js';
import type { LogRow, LogValue } from '../types.js';

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk, encoding, callback) => {
    lines.push(String(chunk));
    expect(encoding).toBe('utf8');
    queueMicrotask(() => {
      if (typeof callback === 'function') callback();
    });
    return true;
  });
});
afterEach(async () => {
  expect(await closeLogging(100)).toBe(true);
  vi.restoreAllMocks();
  setDiagnosticSecrets([]);
});

it('保留错误原因和业务字段, 不复制 SDK 请求对象', () => {
  const error = Object.assign(new Error('connection refused'), {
    code: 'ECONNREFUSED', status: 502, headers: { Authorization: 'private' },
  });
  logging({
    level: 'warn',
    target: 'request',
    event: 'request.failed',
    message: 'Request could not finish.',
    error,
    body: { sessionId: 's1', attempt: 2 },
  });
  expect(JSON.parse(lines[0]!)).toMatchObject({
    target: 'request', pid: process.pid, event: 'request.failed',
    message: 'Request could not finish.',
    error: {
      name: 'Error', message: 'connection refused', code: 'ECONNREFUSED', status: 502,
      stack: expect.stringContaining('connection refused'),
    },
    body: { sessionId: 's1', attempt: 2 },
  });
  expect(lines[0]).not.toContain('headers');
  expect(JSON.parse(lines[0]!)).not.toHaveProperty('source');
  expect(JSON.parse(lines[0]!)).not.toHaveProperty('fields');
});

it('深层敏感字段和已知凭据脱敏, 不修改原对象', () => {
  const secret = 'fake/control secret';
  setDiagnosticSecrets([secret]);
  const input = {
    endpoint: 'https://user:pass@example.test/?token=hidden',
    nested: { apiKey: 'private', authorization: 'Bearer unknown', control: encodeURIComponent(secret) },
  };
  logging({ level: 'warn', target: 'request', event: 'request.failed', body: input });
  expect(lines[0]).not.toMatch(/user:pass|hidden|private|unknown|fake/);
  expect(JSON.parse(lines[0]!).body.nested.apiKey).toBe('[REDACTED]');
  expect(input.nested.apiKey).toBe('private');
});

it('中文, emoji, 换行和引号经过限制后仍是合法的单行 UTF-8 JSON', () => {
  logging({
    level: 'warn', target: 'example', event: 'example.large',
    message: '中😀"\\\n'.repeat(1000),
    body: { rows: Array.from({ length: 32 }, () => 'large'.repeat(1000)) },
  });
  const line = lines[0]!;
  expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LOG_BYTES);
  expect(line.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(line).truncated).toBe(true);
  expect(line).not.toContain('�');
});

it('循环对象, getter 和 toJSON 不影响业务执行', () => {
  const getter = vi.fn(() => { throw new Error('must not execute'); });
  const input: Record<string, LogValue> = { count: 1 };
  const items: LogValue[] = [];
  Object.defineProperty(items, '0', { enumerable: true, get: getter });
  input.items = items;
  input.self = input;
  Object.defineProperty(input, 'danger', { enumerable: true, get: getter });
  Object.defineProperty(input, 'toJSON', { value: getter });
  expect(() => logging({ level: 'info', target: 'example', event: 'example.circular', body: input })).not.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.parse(lines[0]!).body.count).toBe(1);
  expect(JSON.parse(lines[0]!).truncated).toBe(true);
});

it('所有级别都写入, 错误堆栈始终提取并脱敏', () => {
  setDiagnosticSecrets(['private-value']);
  const error = new Error('private-value');
  const levels = ['debug', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    logging({ level, target: 'example', event: 'example.failed', error });
  }
  const rows = lines.map(line => JSON.parse(line) as LogRow);
  expect(rows.map(row => row.level)).toEqual(levels);
  for (const row of rows) {
    expect(row.error?.stack).toContain('[REDACTED]');
    expect(row.error?.stack).not.toContain('private-value');
  }
});

it('超大原值整体省略, 不留下凭据前缀', () => {
  const secret = 'secret-prefix-' + 'x'.repeat(20000);
  setDiagnosticSecrets([secret]);
  logging({
    level: 'warn', target: 'example', event: 'example.oversized',
    message: secret,
    error: new Error(secret),
    body: { secretText: secret },
  });
  expect(lines[0]).not.toContain('secret-prefix-');
  expect(JSON.parse(lines[0]!).truncated).toBe(true);
});

it('固定模块名, 事件名和业务字段名保持原值', () => {
  setDiagnosticSecrets(['example']);
  logging({
    level: 'info', target: 'example', event: 'example.ready',
    message: 'example',
    body: { example: 'example', nested: { example: 'example' } },
  });
  const row = JSON.parse(lines[0]!) as LogRow;
  expect(row.target).toBe('example');
  expect(row.event).toBe('example.ready');
  expect(row.message).toBe('[REDACTED]');
  expect(row.body).toEqual({ example: '[REDACTED]', nested: { example: '[REDACTED]' } });
});

it('循环错误来源会停止提取, 重复的业务对象仍保留', () => {
  const error = new Error('outer');
  const cause = new Error('inner', { cause: error });
  error.cause = cause;
  const shared = { value: 1 };
  logging({
    level: 'warn', target: 'example', event: 'example.failed',
    error,
    body: { first: shared, second: shared },
  });
  const row = JSON.parse(lines[0]!) as LogRow;
  expect(row.error?.cause?.message).toBe('inner');
  expect(row.error?.cause?.cause?.message).toContain('omitted');
  expect(row.truncated).toBe(true);
  expect(row.body).toEqual({ first: shared, second: shared });
});

it('错误链和公共消息也计入整行大小, 非 Error 异常仍有说明', () => {
  let error = new Error('root');
  for (let index = 0; index < 8; index += 1) {
    error = new Error('"\\\t'.repeat(1000), { cause: error });
    error.stack = '"\\\t'.repeat(1000);
  }
  logging({ level: 'error', target: 'example', event: 'example.failed', message: error.message, error });
  expect(Buffer.byteLength(lines[0]!, 'utf8')).toBeLessThanOrEqual(MAX_LOG_BYTES);
  expect(JSON.parse(lines[0]!).truncated).toBe(true);
  logging({ level: 'warn', target: 'example', event: 'example.rejected', error: 'rejected' });
  expect(JSON.parse(lines[1]!).error).toEqual({ message: 'rejected' });
});
