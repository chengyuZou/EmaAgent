// FileEditTool 测试: 先读守卫、范围读取、精确替换、并发防覆盖、
// 外部修改检测、引号归一、replace_all、结构化补丁与 map 投影。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStateCache, type ToolInvocation } from '@ema-agent/tools';
import { FileEditTool } from '../tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeInvocation(callId = 'call-edit-1', signal?: AbortSignal): ToolInvocation {
  return {
    sessionId: '00000000-0000-4000-8000-0000000000e1',
    turnId: '00000000-0000-4000-8000-0000000000e2',
    toolCallId: callId,
    signal: signal ?? new AbortController().signal,
  };
}

function makeContext(callId: string) {
  return {
    fileStateCache: new FileStateCache(),
    cwd: '',
    callId,
  };
}

/** 保存当前完整原文及修改时间. */
function markRead(ctx: ReturnType<typeof makeContext>, target: string): void {
  const content = fs.readFileSync(target, 'utf8');
  ctx.fileStateCache.set(path.resolve(target), {
    content,
    timestamp: fs.statSync(target).mtimeMs,
    totalLines: content.split('\n').length,
    truncated: false,
  });
}

function makeFile(name: string, content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-file-edit-'));
  tempDirs.push(directory);
  const target = path.join(directory, name);
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

async function edit(
  target: string,
  oldString: string,
  newString: string,
  ctx: ReturnType<typeof makeContext>,
  replaceAll = false,
) {
  return FileEditTool.execute(
    { file_path: target, old_string: oldString, new_string: newString, replace_all: replaceAll },
    { fileStateCache: ctx.fileStateCache, cwd: '' },
    makeInvocation(ctx.callId),
  );
}

describe('FileEditTool — 输入与先读守卫', () => {
  it('空 old_string 被 Schema 拒绝,空编辑被 validateInput 拒绝', () => {
    expect(FileEditTool.inputSchema.safeParse({
      file_path: 'a.txt', old_string: '', new_string: 'x',
    }).success).toBe(false);
    const verdict = FileEditTool.validateInput!(
      { file_path: 'a.txt', old_string: 'same', new_string: 'same', replace_all: false },
      { fileStateCache: new FileStateCache(), cwd: '' },
      makeInvocation(),
    );
    expect(verdict).toMatchObject({ valid: false, code: 'edit/empty' });
  });

  it('未读文件直接拒绝,不产生写入', async () => {
    const target = makeFile('missing-read.txt', '旧内容');
    await expect(edit(target, '旧', '新', makeContext('c1')))
      .rejects.toThrow('read first');
    expect(fs.readFileSync(target, 'utf8')).toBe('旧内容');
  });

  it('局部读取后允许在当前文件中精确编辑', async () => {
    const target = makeFile('partial.txt', 'a\nb\nc\n');
    const ctx = makeContext('c2');
    ctx.fileStateCache.set(path.resolve(target), {
      content: 'a\nb',
      timestamp: fs.statSync(target).mtimeMs,
      offset: 1,
      limit: 2,
      totalLines: 4,
      truncated: false,
    });
    await edit(target, 'a', 'x', ctx);
    expect(fs.readFileSync(target, 'utf8')).toBe('x\nb\nc\n');
  });
});

describe('FileEditTool — 替换语义', () => {
  it('真实范围 Read 后连续 Edit, 再 Read 返回最新完整内容', async () => {
    const target = makeFile('read-edit.txt', 'a\nb\nc');
    const ctx = makeContext('read-edit');
    await FileReadTool.execute({ file_path: target, offset: 2, limit: 1 }, ctx, makeInvocation());
    await edit(target, 'b', 'updated', ctx);
    await edit(target, 'updated', 'final', ctx);
    const result = await FileReadTool.execute({ file_path: target }, ctx, makeInvocation());
    expect(result.type).toBe('file_content');
    expect(result).toMatchObject({ content: '     1\ta\n     2\tfinal\n     3\tc' });
  });

  it('全文读取后仅修改时间变化不阻止编辑', async () => {
    const target = makeFile('touched.txt', 'a\nb');
    const ctx = makeContext('touched');
    await FileReadTool.execute({ file_path: target }, ctx, makeInvocation());
    const newer = new Date(fs.statSync(target).mtimeMs + 1000);
    fs.utimesSync(target, newer, newer);
    await edit(target, 'a', 'x', ctx);
    expect(fs.readFileSync(target, 'utf8')).toBe('x\nb');
  });

  it('范围读取后文件修改时间变新时要求重新读, 失败不改缓存', async () => {
    const target = makeFile('changed-partial.txt', 'a\nb');
    const ctx = makeContext('changed-partial');
    await FileReadTool.execute({ file_path: target, offset: 1, limit: 1 }, ctx, makeInvocation());
    const before = ctx.fileStateCache.get(target);
    fs.writeFileSync(target, 'a\nexternal');
    const newer = new Date(fs.statSync(target).mtimeMs + 1000);
    fs.utimesSync(target, newer, newer);
    await expect(edit(target, 'a', 'x', ctx)).rejects.toThrow('modified externally');
    expect(ctx.fileStateCache.get(target)).toBe(before);
  });
  it('LF 多行输入匹配 CRLF 文件并保留原换行', async () => {
    const target = makeFile('crlf.txt', '前文\r\n旧一\r\n旧二\r\n后文\r\n');
    const ctx = makeContext('crlf-edit');
    markRead(ctx, target);

    await edit(target, '旧一\n旧二', '新一\n新二', ctx);

    expect(fs.readFileSync(target, 'utf8')).toBe('前文\r\n新一\r\n新二\r\n后文\r\n');
  });
  it('精确替换并返回完整事实(含 structuredPatch)', async () => {
    const target = makeFile('actual.txt', '前文\n旧内容\n后文\n');
    const ctx = makeContext('c3');
    markRead(ctx, target);

    const result = await edit(target, '旧内容', '新内容', ctx);

    expect(result).toMatchObject({
      filePath: target,
      oldString: '旧内容',
      newString: '新内容',
      replaceAll: false,
      replacements: 1,
    });
    expect(result.originalFile).toBe('前文\n旧内容\n后文\n');
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.structuredPatch.length).toBeGreaterThan(0);
    const allLines = result.structuredPatch.flatMap(h => h.lines);
    expect(allLines.some(l => l === '-旧内容')).toBe(true);
    expect(allLines.some(l => l === '+新内容')).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('前文\n新内容\n后文\n');
    // 缓存更新为新版本: 再次编辑基于新内容
    const ctxEntry = ctx.fileStateCache.get(path.resolve(target))!;
    expect(ctxEntry.content).toBe('前文\n新内容\n后文\n');
  });

  it('old_string 多次出现且未设 replace_all 时拒绝并报告次数', async () => {
    const target = makeFile('multi.txt', 'foo\nfoo\nfoo\n');
    const ctx = makeContext('c4');
    markRead(ctx, target);

    await expect(edit(target, 'foo', 'bar', ctx)).rejects.toThrow('3 times');
    expect(fs.readFileSync(target, 'utf8')).toBe('foo\nfoo\nfoo\n');
  });

  it('replace_all 替换全部并如实计数', async () => {
    const target = makeFile('all.txt', 'foo\nfoo\n');
    const ctx = makeContext('c5');
    markRead(ctx, target);

    const result = await edit(target, 'foo', 'bar', ctx, true);

    expect(result.replacements).toBe(2);
    expect(result.replaceAll).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe('bar\nbar\n');
  });

  it('弯引号文件: 直引号 old_string 命中, new_string 保持弯引号风格', async () => {
    const target = makeFile('quotes.txt', 'say “hello” world\n');
    const ctx = makeContext('c6');
    markRead(ctx, target);

    const result = await edit(target, '“hello”', '"hi"', ctx);

    // old 是文件里的弯引号子串; new 的直引号被转回弯引号
    expect(fs.readFileSync(target, 'utf8')).toBe('say “hi” world\n');
    expect(result.newString).toBe('“hi”');
  });

  it('读取后被外部修改(mtime+内容都变)时拒绝', async () => {
    const target = makeFile('stale.txt', '原版\n');
    const ctx = makeContext('c7');
    markRead(ctx, target);
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(target, '外部改动\n');

    await expect(edit(target, '原版', '新版', ctx)).rejects.toThrow('modified externally');
  });

  it('mtime 未变时仍检查 old_string 是否存在于当前正文', async () => {
    const target = makeFile('stale-mtime.txt', '原版\n');
    const ctx = makeContext('c8');
    markRead(ctx, target);
    const originalMtime = fs.statSync(target).mtimeMs;
    fs.writeFileSync(target, '外部改动\n');
    // 把 mtime 还原到读取时的值,模拟粗粒度文件系统上"内容变但 mtime 未变"。
    fs.utimesSync(target, new Date(originalMtime), new Date(originalMtime));

    await expect(edit(target, '原版', '新版', ctx)).rejects.toThrow('not found');
  });

  it('两个 Session 基于同一旧版本并发编辑时只允许一个提交', async () => {
    const target = makeFile('shared.txt', '共同旧版本');
    const first = makeContext('call-session-a');
    const second = makeContext('call-session-b');
    markRead(first, target);
    markRead(second, target);

    const settled = await Promise.allSettled([
      edit(target, '共同旧版本', '版本 A', first),
      edit(target, '共同旧版本', '版本 B', second),
    ]);

    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(['版本 A', '版本 B']).toContain(fs.readFileSync(target, 'utf8'));
  });
});

describe('FileEditTool.mapResultToModelContent', () => {
  const base = {
    filePath: 'a.txt',
    oldString: 'x',
    newString: 'y',
    originalFile: 'x',
    structuredPatch: [],
    additions: 0,
    deletions: 0,
    replacements: 1,
  };

  it('单次替换: 一句短确认,不带补丁正文', () => {
    const out = FileEditTool.mapResultToModelContent!({ ...base, replaceAll: false });
    expect(out).toBe('The file a.txt has been updated successfully.');
  });

  it('replace_all: 报告替换次数', () => {
    const out = FileEditTool.mapResultToModelContent!({ ...base, replaceAll: true, replacements: 3 });
    expect(out).toContain('All 3 occurrences');
  });
});
