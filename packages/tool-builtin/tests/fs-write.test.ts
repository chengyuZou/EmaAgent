// 这里测试 fs_write 的原子替换、文件状态同步和崩溃临时文件清理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asToolCallId, asSessionId, asTurnId } from '@ema-agent/contracts';
import type { ToolExecutionRecord } from '@ema-agent/contracts';
import type { IFileStateStore, ToolExecutionContext } from '@ema-agent/tools';
import { fsWriteTool } from '../src/tools/fs-write.js';
import { atomicTempPrefix, atomicWriteUtf8 } from '../src/files/atomic-write.js';
import { cleanupInterruptedFsWriteTemps } from '../src/files/fs-write-recovery.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('fs_write', () => {
  it('原子写入后同时更新 turn 缓存和 session 文件状态', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'nested', 'answer.txt');
    const record = vi.fn<IFileStateStore['record']>();
    const ctx = makeContext({ fileStateStore: { record, get: vi.fn(), recentEntries: vi.fn() } });

    const result = await fsWriteTool.unsafeExecute(
      { file_path: target, content: '完整内容' },
      ctx,
    );

    const canonical = fs.realpathSync.native(target);
    expect(result).toMatchObject({ type: 'created', bytesWritten: 12 });
    expect(fs.readFileSync(target, 'utf8')).toBe('完整内容');
    expect(ctx.readFileState.get(canonical)?.content).toBe('完整内容');
    expect(record).toHaveBeenCalledWith(canonical, expect.objectContaining({ content: '完整内容' }));
    expect(listWriteTemps(path.dirname(target))).toEqual([]);
  });

  it('写入在替换前取消时保留旧文件且不遗留临时文件', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'keep.txt');
    fs.writeFileSync(target, '旧内容', 'utf8');
    const controller = new AbortController();
    controller.abort(new Error('测试取消'));

    await expect(atomicWriteUtf8(target, '新内容', 'cancelled-call', controller.signal))
      .rejects.toThrow('测试取消');

    expect(fs.readFileSync(target, 'utf8')).toBe('旧内容');
    expect(listWriteTemps(directory)).toEqual([]);
  });

  it('原子替换失败时保留旧文件，不退回直接覆盖', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'keep-on-error.txt');
    fs.writeFileSync(target, '可靠旧版本', 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('模拟 rename 失败');
    });

    await expect(atomicWriteUtf8(target, '不完整的新版本', 'failed-call'))
      .rejects.toThrow('模拟 rename 失败');

    expect(fs.readFileSync(target, 'utf8')).toBe('可靠旧版本');
    expect(listWriteTemps(directory)).toEqual([]);
  });

  it('不同 Session 同时写同一路径时只会留下一个完整版本', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'shared.txt');
    const first = 'A'.repeat(128 * 1024);
    const second = 'B'.repeat(128 * 1024);

    await Promise.all([
      atomicWriteUtf8(target, first, 'session-a-call'),
      atomicWriteUtf8(target, second, 'session-b-call'),
    ]);

    expect([first, second]).toContain(fs.readFileSync(target, 'utf8'));
    expect(listWriteTemps(directory)).toEqual([]);
  });

  it('启动恢复只删除日志明确对应的中断写入临时文件', () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'recover.txt');
    const callId = asToolCallId('call-recover');
    const matching = path.join(directory, `${atomicTempPrefix(target, callId)}one.tmp`);
    const unrelated = path.join(directory, `${atomicTempPrefix(target, 'other-call')}two.tmp`);
    fs.writeFileSync(matching, '半成品', 'utf8');
    fs.writeFileSync(unrelated, '别的调用', 'utf8');

    const result = cleanupInterruptedFsWriteTemps([
      executionRecord(callId, target, 'outcome_unknown'),
      executionRecord(asToolCallId('call-finished'), target, 'succeeded'),
    ]);

    expect(result).toEqual({ removed: [matching], failed: [] });
    expect(fs.existsSync(matching)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('别的调用');
  });
});

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 'session-test',
    turnId: 'turn-test',
    toolCallId: asToolCallId('call-write'),
    workspaceRoot: '',
    signal: new AbortController().signal,
    readFileState: new Map(),
    ...overrides,
  };
}

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-fs-write-'));
  tempDirs.push(directory);
  return directory;
}

function listWriteTemps(directory: string): string[] {
  return fs.readdirSync(directory).filter(name => name.includes('.ema-write-'));
}

function executionRecord(
  callId: ReturnType<typeof asToolCallId>,
  target: string,
  status: ToolExecutionRecord['status'],
): ToolExecutionRecord {
  return {
    callId,
    sessionId: asSessionId('session-test'),
    turnId: asTurnId('turn-test'),
    toolName: 'fs_write',
    inputJson: JSON.stringify({ file_path: target, content: '内容' }),
    inputDigest: 'digest',
    status,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
