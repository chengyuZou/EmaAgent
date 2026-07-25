// 测试搜索子进程与 Glob/Grep 会在记录数、字节数和时间预算处停止生产。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuiltTool } from '@ema-agent/tools';
import { splitToolResult } from '@ema-agent/tools';
import type { BuiltinToolContext } from '../builtinToolContext.js';
import { GlobTool } from '../tools/GlobTool/GlobTool.js';
import { GrepTool } from '../tools/GrepTool/GrepTool.js';
import { runBoundedProcess } from '../tools/shared/BoundedProcess.js';

const tempDirs: string[] = [];
const hasRipgrep = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0;

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('bounded search', () => {
  it('达到记录上限后终止仍在大量输出的子进程', async () => {
    const result = await runBoundedProcess(
      process.execPath,
      ['-e', "for(let i=0;i<10000;i++)process.stdout.write(i+'\\n')"],
      {
        delimiter: '\n',
        maxRecords: 5,
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      },
    );

    expect(result.records).toEqual(['0', '1', '2', '3', '4']);
    expect(result).toMatchObject({ truncated: true, stopReason: 'records' });
  });

  it('达到字节上限时不会把超大输出累积进内存', async () => {
    const result = await runBoundedProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(200000))"],
      {
        delimiter: '\n',
        maxRecords: 100,
        maxBytes: 1_024,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      },
    );

    expect(result.records).toEqual([]);
    expect(result).toMatchObject({ truncated: true, stopReason: 'bytes' });
  });

  it('Glob 最多返回 100 个文件并明确标记截断', async () => {
    const directory = makeTempDir();
    for (let index = 0; index < 140; index += 1) {
      fs.writeFileSync(path.join(directory, `file-${index}.txt`), String(index), 'utf8');
    }

    const result = await executeWithContext(
      GlobTool,
      { pattern: '*.txt' },
      makeContext(directory),
    ) as { files: string[]; truncated: boolean; notice?: string };

    expect(result.files).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('most recently modified');
    expect(splitToolResult(result).presentation).toMatchObject({
      kind: 'search',
      operation: 'file_search',
      pattern: '*.txt',
      resultCount: 100,
      truncated: true,
      limitReason: 'results',
    });
  });

  it.skipIf(!hasRipgrep)('Grep 按 head_limit 截断并提示模型缩小范围', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(
      path.join(directory, 'many.txt'),
      Array.from({ length: 300 }, (_, index) => `match-${index}`).join('\n'),
      'utf8',
    );

    const result = await executeWithContext(
      GrepTool,
      {
        pattern: 'match-',
        output_mode: 'content',
        case_insensitive: false,
        head_limit: 10,
      },
      makeContext(directory),
    ) as { output: string; truncated: boolean; stopReason?: string };

    expect(result.truncated).toBe(true);
    expect(result.stopReason).toBe('records');
    expect(result.output).toContain('Use a narrower pattern');
    expect(splitToolResult(result).presentation).toMatchObject({
      kind: 'search',
      operation: 'content_search',
      pattern: 'match-',
      resultCount: 10,
      truncated: true,
      limitReason: 'results',
    });
  });

  it.skipIf(!hasRipgrep)('Grep 把以短横线开头的 pattern 当作内容而不是 rg 参数', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'literal.txt'), '--files\nordinary', 'utf8');

    const result = await executeWithContext(
      GrepTool,
      {
        pattern: '--files',
        output_mode: 'content',
        case_insensitive: false,
        head_limit: 10,
      },
      makeContext(directory),
    ) as { output: string; truncated: boolean };

    expect(result.output).toContain('--files');
    expect(result.truncated).toBe(false);
  });
});

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-bounded-search-'));
  tempDirs.push(directory);
  return directory;
}

function makeContext(
  workspaceRoot: string,
): BuiltinToolContext {
  return {
    sessionId: 'session-test' as BuiltinToolContext['sessionId'],
    turnId: 'turn-test' as BuiltinToolContext['turnId'],
    workspaceRoot,
    signal: new AbortController().signal,
  };
}

async function executeWithContext(
  tool: BuiltTool,
  input: unknown,
  context: BuiltinToolContext,
): Promise<unknown> {
  const projection = tool.unsafeValidateContext(context);
  if (!projection.valid) throw new Error(projection.reason);
  return tool.unsafeExecute(input, projection.context);
}

describe('Glob newest-first 契约(2D)', () => {
  it('返回的是按 mtime 最新的 100 个, 不是遍历序前 100 个', async () => {
    const directory = makeTempDir();
    // 遍历序最后的 20 个文件 mtime 最新——旧实现会漏掉它们。
    const total = 120;
    for (let index = 0; index < total; index += 1) {
      const file = path.join(directory, `file-${String(index).padStart(3, '0')}.txt`);
      fs.writeFileSync(file, String(index), 'utf8');
      // index 越大 mtime 越新
      const mtime = new Date(1_700_000_000_000 + index * 1000);
      fs.utimesSync(file, mtime, mtime);
    }

    const result = await executeWithContext(
      GlobTool,
      { pattern: '*.txt' },
      makeContext(directory),
    ) as { files: string[]; truncated: boolean };

    expect(result.files).toHaveLength(100);
    expect(result.truncated).toBe(true);
    // 最新的 file-119 必须在, 最旧的 file-000 必须不在
    expect(result.files.some((f) => f.endsWith('file-119.txt'))).toBe(true);
    expect(result.files.some((f) => f.endsWith('file-000.txt'))).toBe(false);
    // 且整体按 mtime 降序: 第一个就是最新的
    expect(result.files[0]).toContain('file-119.txt');
  });

  it.skipIf(hasRipgrep)('Grep 在 rg 缺失时给出可执行的明确错误', async () => {
    const directory = makeTempDir();
    await expect(
      executeWithContext(
        GrepTool,
        { pattern: 'anything', output_mode: 'files_with_matches', case_insensitive: false, head_limit: 10 },
        makeContext(directory),
      ),
    ).rejects.toThrow('ripgrep (rg) is not installed');
  });
});

describe('Grep 工业细节(2D 二轮, 需 rg)', () => {
  it('schema 暴露 type/multiline/offset/分离上下文', () => {
    const properties = GrepTool.descriptor().inputJsonSchema['properties'] as Record<string, unknown>;
    for (const key of ['type', 'multiline', 'offset', 'context_before', 'context_after']) {
      expect(properties, `missing ${key}`).toHaveProperty(key);
    }
  });

  it.skipIf(!hasRipgrep)('超长行被 --max-columns 跳过, 不吃掉结果预算', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(
      path.join(directory, 'min.js'),
      'needle ' + 'x'.repeat(200_000),
      'utf8',
    );
    fs.writeFileSync(path.join(directory, 'normal.js'), 'needle here\n', 'utf8');

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'needle', output_mode: 'content', case_insensitive: false, head_limit: 10 },
      makeContext(directory),
    ) as { output: string };

    expect(result.output).toContain('normal.js');
    expect(result.output).not.toContain('min.js');
    expect(result.output.length).toBeLessThan(10_000);
  });

  it.skipIf(!hasRipgrep)('type 过滤只搜指定文件类型', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'a.ts'), 'target\n');
    fs.writeFileSync(path.join(directory, 'b.js'), 'target\n');

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'target', output_mode: 'files_with_matches', case_insensitive: false, head_limit: 10, type: 'ts' },
      makeContext(directory),
    ) as { output: string };

    expect(result.output).toContain('a.ts');
    expect(result.output).not.toContain('b.js');
  });

  it.skipIf(!hasRipgrep)('offset 分页拿到后续页', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(
      path.join(directory, 'many.txt'),
      Array.from({ length: 30 }, (_, i) => `match-${String(i).padStart(2, '0')}`).join('\n'),
      'utf8',
    );

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'match-', output_mode: 'content', case_insensitive: false, head_limit: 5, offset: 25 },
      makeContext(directory),
    ) as { output: string; truncated: boolean };

    expect(result.output).toContain('match-25');
    expect(result.output).toContain('match-29');
    expect(result.output).not.toContain('match-00');
    expect(result.truncated).toBe(false);
  });

  it.skipIf(!hasRipgrep)('输出为相对路径, 不泄漏工作区绝对路径', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'sub', 'f.txt').replace(/\\/g, '/'), 'hello\n');
    fs.mkdirSync(path.join(directory, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'sub', 'f.txt'), 'hello\n');

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'hello', output_mode: 'files_with_matches', case_insensitive: false, head_limit: 10 },
      makeContext(directory),
    ) as { output: string };

    expect(result.output).not.toContain(directory);
    expect(result.output).toContain('f.txt');
  });

  it.skipIf(!hasRipgrep)('multiline 开启后跨行模式可匹配', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'm.txt'), 'start\nmiddle\nend\n');

    const without = await executeWithContext(
      GrepTool,
      { pattern: 'start\nmiddle', output_mode: 'content', case_insensitive: false, head_limit: 10 },
      makeContext(directory),
    ) as { output: string };
    expect(without.output.trim()).toBe('');

    const withMultiline = await executeWithContext(
      GrepTool,
      { pattern: 'start\nmiddle', output_mode: 'content', case_insensitive: false, head_limit: 10, multiline: true },
      makeContext(directory),
    ) as { output: string };
    expect(withMultiline.output).toContain('start');
  });

  it.skipIf(!hasRipgrep)('count 模式附带总计摘要', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'a.txt'), 'x\nx\n');
    fs.writeFileSync(path.join(directory, 'b.txt'), 'x\n');

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'x', output_mode: 'count', case_insensitive: false, head_limit: 10 },
      makeContext(directory),
    ) as { output: string };

    expect(result.output).toContain('Found 3 total occurrences across 2 files.');
  });

  it.skipIf(!hasRipgrep)('files_with_matches 按 mtime 降序', async () => {
    const directory = makeTempDir();
    const older = path.join(directory, 'older.txt');
    const newer = path.join(directory, 'newer.txt');
    fs.writeFileSync(older, 'hit\n');
    fs.writeFileSync(newer, 'hit\n');
    fs.utimesSync(older, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    fs.utimesSync(newer, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'hit', output_mode: 'files_with_matches', case_insensitive: false, head_limit: 10 },
      makeContext(directory),
    ) as { output: string };

    expect(result.output.indexOf('newer.txt')).toBeLessThan(result.output.indexOf('older.txt'));
  });

  it.skipIf(!hasRipgrep)('分离上下文 -B/-A 生效', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'c.txt'), 'before1\nbefore2\nhit\nafter1\nafter2\n');

    const result = await executeWithContext(
      GrepTool,
      { pattern: 'hit', output_mode: 'content', case_insensitive: false, head_limit: 10, context_before: 1, context_after: 1 },
      makeContext(directory),
    ) as { output: string };

    expect(result.output).toContain('before2');
    expect(result.output).toContain('after1');
    expect(result.output).not.toContain('before1');
    expect(result.output).not.toContain('after2');
  });
});
