// 测试 FileWriteTool 的原子替换、覆盖前读取守卫、真实 diff 和崩溃临时文件清理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asToolCallId, asSessionId, asTurnId } from '@ema-agent/ids';
import type { FileStateStore, ToolExecutionRecord } from '@ema-agent/tools';
import { splitToolResult } from '@ema-agent/tools';
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js';
import { atomicTempPrefix, atomicWriteUtf8 } from '../tools/FileWriteTool/atomicWrite.js';
import { cleanupInterruptedFileWriteTemps } from '../tools/FileWriteTool/recovery.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileWriteTool', () => {
  it('原子写入后同时更新 turn 缓存和 session 文件状态', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'nested', 'answer.txt');
    const record = vi.fn<FileStateStore['record']>();
    const execution = makeContext({
      fileStateStore: { record, get: vi.fn(), recentEntries: vi.fn() },
    });

    const result = await FileWriteTool.unsafeExecute(
      { file_path: target, content: '完整内容' },
      execution,
    );

    const canonical = fs.realpathSync.native(target);
    expect(result).toMatchObject({ type: 'created', bytesWritten: 12 });
    expect(splitToolResult(result).presentation).toMatchObject({
      kind: 'file_change',
      operation: 'create',
      filePath: target,
      additions: 1,
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('完整内容');
    expect(execution.readFileState.get(canonical)?.content).toBe('完整内容');
    expect(record).toHaveBeenCalledWith(canonical, expect.objectContaining({ content: '完整内容' }));
    expect(listWriteTemps(path.dirname(target))).toEqual([]);
  });

  it('拒绝在没有完整 Read 状态时覆盖已有文件', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'existing.txt');
    fs.writeFileSync(target, '旧内容', 'utf8');

    await expect(FileWriteTool.unsafeExecute(
      { file_path: target, content: '新内容' },
      makeContext(),
    )).rejects.toThrow('read in full first');

    expect(fs.readFileSync(target, 'utf8')).toBe('旧内容');
    expect(listWriteTemps(directory)).toEqual([]);
  });

  it('已有文件完整读过且未变更时允许覆盖并展示真实 diff', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'existing.txt');
    fs.writeFileSync(target, '第一行\n旧内容\n', 'utf8');
    const stat = fs.statSync(target);
    const execution = makeContext();
    execution.readFileState.set(path.resolve(target), {
      content: '第一行\n旧内容\n',
      timestamp: stat.mtimeMs,
      isPartialView: false,
    });

    const result = await FileWriteTool.unsafeExecute(
      { file_path: target, content: '第一行\n新内容\n' },
      execution,
    );
    const split = splitToolResult(result);

    expect(split.modelOutput).toMatchObject({ type: 'updated' });
    expect(split.presentation).toMatchObject({ additions: 1, deletions: 1 });
    expect(split.presentation?.kind === 'file_change' && split.presentation.unifiedDiff)
      .toContain('+新内容');
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

    const result = cleanupInterruptedFileWriteTemps([
      executionRecord(callId, target, 'outcome_unknown'),
      executionRecord(asToolCallId('call-finished'), target, 'succeeded'),
    ]);

    expect(result).toEqual({ removed: [matching], failed: [] });
    expect(fs.existsSync(matching)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('别的调用');
  });
});

// 构造 FileWriteTool 的窄 Context：去重缓存 + 可选持久状态 + per-call 身份。
function makeContext(overrides: { fileStateStore?: FileStateStore } = {}) {
  return {
    readFileState: new Map(),
    signal: new AbortController().signal,
    toolCallId: asToolCallId('call-write'),
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
    toolName: 'builtin.file.write',
    inputJson: JSON.stringify({ file_path: target, content: '内容' }),
    inputDigest: 'digest',
    status,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
