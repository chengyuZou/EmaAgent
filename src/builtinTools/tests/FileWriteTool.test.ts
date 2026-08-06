// FileWriteTool 收口测试: 新建/覆盖守卫、外部修改拒绝、原子替换与崩溃恢复、
// 完整事实(content/originalFile/structuredPatch)与 map 投影。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asToolCallId, asSessionId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../BuiltinToolIdentity.js';
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js';
import { atomicTempPrefix, atomicWriteUtf8 } from '../tools/FileWriteTool/atomicWrite.js';
import {
  cleanupInterruptedFileWriteTemps,
  type InterruptedFileWriteCall,
} from '../tools/FileWriteTool/recovery.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeInvocation(signal?: AbortSignal): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000d1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000d2'),
    toolCallId: asToolCallId('call-write'),
    signal: signal ?? new AbortController().signal,
  };
}

function makeContext(workspaceRoot = '') {
  return {
    readFileState: new Map(),
    workspaceRoot,
  };
}

async function write(
  filePath: string,
  content: string,
  ctx: ReturnType<typeof makeContext>,
) {
  return FileWriteTool.execute({ file_path: filePath, content }, ctx, makeInvocation());
}

describe('FileWriteTool — 新建与覆盖', () => {
  it('新建文件并返回完整事实(created: originalFile=null, patch 为空)', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'nested', 'answer.txt');
    const ctx = makeContext();

    const result = await write(target, '完整内容', ctx);

    expect(result.type).toBe('created');
    expect(result.bytesWritten).toBe(12);
    expect(result.content).toBe('完整内容');
    expect(result.originalFile).toBeNull();
    expect(result.structuredPatch).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('完整内容');
    // 缓存更新: 后续 Edit 无需重读
    const canonical = fs.realpathSync.native(target);
    expect(ctx.readFileState.get(canonical)?.content).toBe('完整内容');
    expect(listWriteTemps(path.dirname(target))).toEqual([]);
  });

  it('拒绝在没有完整 Read 状态时覆盖已有文件', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'existing.txt');
    fs.writeFileSync(target, '旧内容', 'utf8');

    await expect(write(target, '新内容', makeContext())).rejects.toThrow('read in full first');
    expect(fs.readFileSync(target, 'utf8')).toBe('旧内容');
    expect(listWriteTemps(directory)).toEqual([]);
  });

  it('已有文件完整读过且未变更时允许覆盖, 返回前文与结构化补丁', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'existing.txt');
    fs.writeFileSync(target, '第一行\n旧内容\n', 'utf8');
    const stat = fs.statSync(target);
    const ctx = makeContext();
    ctx.readFileState.set(path.resolve(target), {
      content: '第一行\n旧内容\n',
      timestamp: stat.mtimeMs,
      isPartialView: false,
      truncated: false,
    });

    const result = await write(target, '第一行\n新内容\n', ctx);

    expect(result.type).toBe('updated');
    expect(result.originalFile).toBe('第一行\n旧内容\n');
    const lines = result.structuredPatch.flatMap((h) => h.lines);
    expect(lines.some((l) => l === '-旧内容')).toBe(true);
    expect(lines.some((l) => l === '+新内容')).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('第一行\n新内容\n');
  });

  it('读取后被外部改动时拒绝覆盖', async () => {
    const directory = makeTempDir();
    const target = path.join(directory, 'stale.txt');
    fs.writeFileSync(target, '原版', 'utf8');
    const ctx = makeContext();
    ctx.readFileState.set(path.resolve(target), {
      content: '原版',
      timestamp: fs.statSync(target).mtimeMs,
      isPartialView: false,
      truncated: false,
    });
    fs.writeFileSync(target, '外部改动', 'utf8');

    await expect(write(target, '新版', ctx)).rejects.toThrow('modified externally');
    expect(fs.readFileSync(target, 'utf8')).toBe('外部改动');
  });
});

describe('FileWriteTool — 原子写与恢复', () => {
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
      interruptedCall(callId, target, true),
      interruptedCall(asToolCallId('call-finished'), target, false),
    ]);

    expect(result).toEqual({ removed: [matching], failed: [] });
    expect(fs.existsSync(matching)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('别的调用');
  });
});

describe('FileWriteTool — 路径与守卫', () => {
  it('相对路径按工作区解析, 不借 Core 进程 cwd', async () => {
    const workspace = makeTempDir();
    const ctx = makeContext(workspace);

    const result = await FileWriteTool.execute(
      { file_path: 'nested/rel.txt', content: '相对写入' },
      ctx,
      makeInvocation(),
    );

    const expected = path.join(workspace, 'nested', 'rel.txt');
    expect(result.type).toBe('created');
    expect(fs.readFileSync(expected, 'utf8')).toBe('相对写入');
    expect(ctx.readFileState.get(path.resolve(workspace, 'nested/rel.txt'))?.content)
      .toBe('相对写入');
  });

  it('UNC 写路径拒绝(Windows SMB 凭据泄露防御)', async () => {
    if (process.platform !== 'win32') return;
    const workspace = makeTempDir();
    // 用 charCode 构造, 避免转义层把 UNC 双反斜杠吃掉。
    const uncPath = String.fromCharCode(92, 92) + 'server\\share\\leak.txt';

    await expect(write(uncPath, 'x', makeContext(workspace))).rejects.toThrow('UNC');
  });

  it('目标是目录时给明确错误, 不等到 rename 失败', async () => {
    const workspace = makeTempDir();
    const dirTarget = path.join(workspace, 'a-directory');
    fs.mkdirSync(dirTarget);

    await expect(write(dirTarget, 'x', makeContext(workspace))).rejects.toThrow('directory');
  });

  it('设备路径黑名单与 Read 同源', async () => {
    const { isBlockedDevice } = await import('../tools/FileReadTool/FileReadTool.js');
    expect(isBlockedDevice('/dev/null')).toBe(true);
    expect(isBlockedDevice('/dev/zero')).toBe(true);
    expect(isBlockedDevice('/dev/tty')).toBe(true);
    expect(isBlockedDevice('/tmp/normal.txt')).toBe(false);
  });
});

describe('FileWriteTool.mapResultToModelContent', () => {
  const base = {
    filePath: 'a.txt',
    bytesWritten: 3,
    content: 'abc',
    structuredPatch: [],
  };

  it('created 与 updated 各一句短确认', () => {
    expect(FileWriteTool.mapResultToModelContent!({
      ...base, type: 'created', originalFile: null,
    })).toBe('File created successfully at: a.txt');
    expect(FileWriteTool.mapResultToModelContent!({
      ...base, type: 'updated', originalFile: 'x',
    })).toBe('The file a.txt has been updated successfully.');
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-fs-write-'));
  tempDirs.push(directory);
  return directory;
}

function listWriteTemps(directory: string): string[] {
  return fs.readdirSync(directory).filter(name => name.includes('.ema-write-'));
}

function interruptedCall(
  callId: ReturnType<typeof asToolCallId>,
  target: string,
  outcomeUnknown: boolean,
): InterruptedFileWriteCall {
  return {
    callId,
    toolName: BuiltinTools.FileWrite.id,
    args: { file_path: target },
    outcomeUnknown,
  };
}
