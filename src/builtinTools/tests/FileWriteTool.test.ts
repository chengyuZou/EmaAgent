// 测试 FileWriteTool 的原子替换、覆盖前读取守卫、真实 diff 和崩溃临时文件清理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asToolCallId, asSessionId, asTurnId } from '@ema-agent/ids';
import type { ToolExecutionRecord } from '@ema-agent/tools';
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
  it('原子写入后更新当前 Turn 的读取状态', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'nested', 'answer.txt');
    const execution = makeContext();

    const result = await FileWriteTool.unsafeExecute(
      { file_path: target, content: '完整内容' },
      execution,
    );

    const canonical = fs.realpathSync.native(target);
    expect(result).toMatchObject({ type: 'created', bytesWritten: 12 });
    expect(fs.readFileSync(target, 'utf8')).toBe('完整内容');
    expect(execution.readFileState.get(canonical)?.content).toBe('完整内容');
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

  it('已有文件完整读过且未变更时允许覆盖', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'existing.txt');
    fs.writeFileSync(target, '第一行\n旧内容\n', 'utf8');
    const stat = fs.statSync(target);
    const execution = makeContext();
    execution.readFileState.set(path.resolve(target), {
      content: '第一行\n旧内容\n',
      timestamp: stat.mtimeMs,
      isPartialView: false,
      truncated: false,
    });

    const result = await FileWriteTool.unsafeExecute(
      { file_path: target, content: '第一行\n新内容\n' },
      execution,
    );
    expect(result).toMatchObject({ type: 'updated' });
    expect(fs.readFileSync(target, 'utf8')).toBe('第一行\n新内容\n');
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

// 构造 FileWriteTool 的窄 Context：写入保护状态 + 单次调用身份 + 工作区。
function makeContext(workspaceRoot = '') {
  return {
    readFileState: new Map(),
    signal: new AbortController().signal,
    toolCallId: asToolCallId('call-write'),
    workspaceRoot,
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

describe('FileWriteTool — 路径与守卫(2D)', () => {
  it('相对路径按工作区解析, 不借 Core 进程 cwd', async () => {
    const workspace = makeTempDir();
    const execution = makeContext(workspace);

    const result = await FileWriteTool.unsafeExecute(
      { file_path: 'nested/rel.txt', content: '相对写入' },
      execution,
    );

    const expected = path.join(workspace, 'nested', 'rel.txt');
    expect(result.type).toBe('created');
    expect(fs.readFileSync(expected, 'utf8')).toBe('相对写入');
    expect(execution.readFileState.get(path.resolve(workspace, 'nested/rel.txt'))?.content)
      .toBe('相对写入');
  });

  it('UNC 写路径拒绝(Windows SMB 凭据泄露防御)', async () => {
    if (process.platform !== 'win32') return;
    const workspace = makeTempDir();
    // 用 charCode 构造, 避免转义层把 UNC 双反斜杠吃掉。
    const uncPath = String.fromCharCode(92, 92) + 'server\\share\\leak.txt';

    await expect(FileWriteTool.unsafeExecute(
      { file_path: uncPath, content: 'x' },
      makeContext(workspace),
    )).rejects.toThrow('UNC');
  });

  it('目标是目录时给明确错误, 不等到 rename 失败', async () => {
    const workspace = makeTempDir();
    const dirTarget = path.join(workspace, 'a-directory');
    fs.mkdirSync(dirTarget);

    await expect(FileWriteTool.unsafeExecute(
      { file_path: dirTarget, content: 'x' },
      makeContext(workspace),
    )).rejects.toThrow('directory');
  });

  it('设备路径黑名单与 Read 同源', async () => {
    const { isBlockedDevice } = await import('../tools/FileReadTool/FileReadTool.js');
    expect(isBlockedDevice('/dev/null')).toBe(true);
    expect(isBlockedDevice('/dev/zero')).toBe(true);
    expect(isBlockedDevice('/dev/tty')).toBe(true);
    expect(isBlockedDevice('/tmp/normal.txt')).toBe(false);
  });
});
