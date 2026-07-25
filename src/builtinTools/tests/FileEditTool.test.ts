// 测试 FileEditTool 的先读守卫、真实 diff 和跨 Session 并发防覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asToolCallId } from '@ema-agent/ids';
import { splitToolResult } from '@ema-agent/tools';
import { FileEditTool } from '../tools/FileEditTool/FileEditTool.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileEditTool', () => {
  it('在进入执行器前拒绝空 old_string，避免空串替换死循环', () => {
    expect(() => FileEditTool.parseInput({
      file_path: 'demo.txt',
      old_string: '',
      new_string: 'x',
      replace_all: false,
    })).toThrow();
  });

  it('拒绝编辑没有完整读取状态的文件', async () => {
    const target = makeFile('missing-read.txt', '旧内容');

    await expect(FileEditTool.unsafeExecute(
      { file_path: target, old_string: '旧', new_string: '新', replace_all: false },
      makeContext('call-no-read'),
    )).rejects.toThrow('read first');

    expect(fs.readFileSync(target, 'utf8')).toBe('旧内容');
  });

  it('返回基于实际完整文件的 diff，而不是根据模型参数猜 diff', async () => {
    const target = makeFile('actual-diff.txt', '前文\n旧内容\n后文\n');
    const ctx = makeReadContext(target, 'call-diff');

    const result = await FileEditTool.unsafeExecute(
      { file_path: target, old_string: '旧内容', new_string: '新内容', replace_all: false },
      ctx,
    );
    const split = splitToolResult(result);

    expect(split.modelOutput).toMatchObject({ filePath: target, replacements: 1 });
    expect(split.presentation).toMatchObject({ additions: 1, deletions: 1, truncated: false });
    if (split.presentation?.kind !== 'file_change') throw new Error('缺少文件变更展示数据');
    expect(split.presentation.unifiedDiff).toContain(' 前文');
    expect(split.presentation.unifiedDiff).toContain('-旧内容');
    expect(split.presentation.unifiedDiff).toContain('+新内容');
  });

  it('两个 Session 基于同一旧版本并发编辑时只允许一个提交', async () => {
    const target = makeFile('shared.txt', '共同旧版本');
    const firstContext = makeReadContext(target, 'call-session-a');
    const secondContext = makeReadContext(target, 'call-session-b');

    const settled = await Promise.allSettled([
      FileEditTool.unsafeExecute(
        { file_path: target, old_string: '共同旧版本', new_string: '版本 A', replace_all: false },
        firstContext,
      ),
      FileEditTool.unsafeExecute(
        { file_path: target, old_string: '共同旧版本', new_string: '版本 B', replace_all: false },
        secondContext,
      ),
    ]);

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(['版本 A', '版本 B']).toContain(fs.readFileSync(target, 'utf8'));
  });
});

// 构造 FileEditTool 的窄 Context：去重缓存 + per-call 身份 + 取消信号。
function makeContext(callId: string) {
  return {
    readFileState: new Map(),
    signal: new AbortController().signal,
    toolCallId: asToolCallId(callId),
  };
}

function makeReadContext(target: string, callId: string) {
  const context = makeContext(callId);
  const content = fs.readFileSync(target, 'utf8');
  context.readFileState.set(path.resolve(target), {
    content,
    timestamp: fs.statSync(target).mtimeMs,
    isPartialView: false,
    truncated: false,
  });
  return context;
}

function makeFile(name: string, content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-file-edit-'));
  tempDirs.push(directory);
  const target = path.join(directory, name);
  fs.writeFileSync(target, content, 'utf8');
  return target;
}
