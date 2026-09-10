// 测试外置工具结果按文件年龄异步回收。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolResultCleaner } from '../results/toolResultCleaner.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('外置工具结果清理', () => {
  it('删除超过 TTL 的结果并保留较新的结果', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tool-cleaner-'));
    temporaryDirectories.push(sessionsDir);
    const resultsDir = path.join(sessionsDir, 'session-1', 'tool-results');
    fs.mkdirSync(resultsDir, { recursive: true });

    const expired = path.join(resultsDir, 'expired.txt');
    const current = path.join(resultsDir, 'current.txt');
    fs.writeFileSync(expired, 'old');
    fs.writeFileSync(current, 'new');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    fs.utimesSync(expired, eightDaysAgo, eightDaysAgo);

    const result = await new ToolResultCleaner(sessionsDir).sweep();

    expect(result).toEqual({ deleted: 1, freedBytes: 3 });
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.readFileSync(current, 'utf8')).toBe('new');
  });

  it('Sessions 目录尚不存在时直接完成', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tool-cleaner-empty-'));
    temporaryDirectories.push(root);

    await expect(new ToolResultCleaner(path.join(root, 'sessions')).sweep())
      .resolves.toEqual({ deleted: 0, freedBytes: 0 });
  });

  it('单 Session 超过配额时从最旧的结果开始删除', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tool-cleaner-quota-'));
    temporaryDirectories.push(sessionsDir);
    const resultsDir = path.join(sessionsDir, 'session-1', 'tool-results');
    fs.mkdirSync(resultsDir, { recursive: true });

    const oldest = path.join(resultsDir, 'oldest.txt');
    const newest = path.join(resultsDir, 'newest.txt');
    const fileBytes = 26 * 1024 * 1024;
    fs.writeFileSync(oldest, '');
    fs.writeFileSync(newest, '');
    fs.truncateSync(oldest, fileBytes);
    fs.truncateSync(newest, fileBytes);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000);
    fs.utimesSync(oldest, oneHourAgo, oneHourAgo);

    const result = await new ToolResultCleaner(sessionsDir).sweep();

    expect(result).toEqual({ deleted: 1, freedBytes: fileBytes });
    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(newest)).toBe(true);
  });
});
