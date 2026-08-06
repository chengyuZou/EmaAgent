// GrepTool 收口测试: 三种输出模式(files_with_matches/count/content)、glob 过滤、
// 大小写、mtime 排序、head_limit/offset 分页与截断、map 三形态投影、validateInput。
// rg 是外部二进制: 机器无 rg 时整组跳过(测试环境需安装 ripgrep)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { GrepTool, type GrepResult } from '../tools/GrepTool/GrepTool.js';

const hasRipgrep = spawnSync('rg', ['--version'], { windowsHide: true }).status === 0;

// 临时目录统一登记, 每个用例结束清理。
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-grep-'));
  tempDirs.push(dir);
  return dir;
}

function makeInvocation(): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000f1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000f2'),
    toolCallId: asToolCallId('call-grep-1'),
    signal: new AbortController().signal,
  };
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

type GrepInputShape = Parameters<typeof GrepTool.execute>[0];

async function grep(
  input: Record<string, unknown>,
  workspaceRoot: string,
): Promise<GrepResult> {
  // 镜像生产链路: 注册表先 inputSchema.parse 再 execute, 默认值(default)在此生效。
  const parsed = GrepTool.inputSchema.parse(input);
  return GrepTool.execute(parsed as GrepInputShape, { workspaceRoot }, makeInvocation());
}

describe.skipIf(!hasRipgrep)('GrepTool', () => {
  it('files_with_matches 默认模式: 列出含模式的相对路径', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'), 'const x = 1\n// hello');
    write(path.join(ws, 'sub', 'b.ts'), 'const x = 2\n');
    write(path.join(ws, 'c.md'), 'no match here');

    const result = await grep({ pattern: 'const x' }, ws);

    expect(result.type).toBe('files_with_matches');
    if (result.type !== 'files_with_matches') return;
    expect(result.files.sort()).toEqual(['a.ts', 'sub/b.ts']);
    expect(result.truncated).toBe(false);
  });

  it('files_with_matches 按 mtime 降序(最近修改在前)', async () => {
    const ws = makeDir();
    const a = path.join(ws, 'a.ts');
    const b = path.join(ws, 'b.ts');
    write(a, 'const x = 1');
    write(b, 'const x = 2');
    fs.utimesSync(a, new Date(1000), new Date(1000));
    fs.utimesSync(b, new Date(2000), new Date(2000));

    const result = await grep({ pattern: 'const x' }, ws);

    if (result.type !== 'files_with_matches') return;
    expect(result.files[0]).toBe('b.ts');
    expect(result.files[1]).toBe('a.ts');
  });

  it('无匹配 → 空列表, map 投影为 No files found', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'), 'const x = 1');

    const result = await grep({ pattern: 'zzz_none' }, ws);

    expect(GrepTool.mapResultToModelContent!(result)).toBe('No files found');
  });

  it('content 模式: 匹配行带行号, 支持 context', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'), 'line one\nconst x = 1\nline three');

    const result = await grep({ pattern: 'const x', output_mode: 'content' }, ws);

    expect(result.type).toBe('content');
    if (result.type !== 'content') return;
    expect(result.output).toContain('a.ts:2:const x = 1');
    expect(result.numLines).toBe(1);

    const withCtx = await grep({ pattern: 'const x', output_mode: 'content', context: 1 }, ws);
    if (withCtx.type !== 'content') return;
    expect(withCtx.output).toContain('line one');
    expect(withCtx.output).toContain('line three');
  });

  it('count 模式: 汇总进 map 投影', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'), 'const x = 1\nconst x = 2');
    write(path.join(ws, 'b.ts'), 'const x = 3');

    const result = await grep({ pattern: 'const x', output_mode: 'count' }, ws);

    expect(result.type).toBe('count');
    if (result.type !== 'count') return;
    expect(result.totalMatches).toBe(3);
    expect(result.fileCount).toBe(2);
    const model = GrepTool.mapResultToModelContent!(result);
    expect(String(model)).toContain('3 total occurrences across 2 files');
  });

  it('glob 过滤与大小写', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'), 'Hello World');
    write(path.join(ws, 'b.md'), 'Hello World');

    const filtered = await grep({ pattern: 'Hello', glob: '*.ts' }, ws);
    if (filtered.type !== 'files_with_matches') return;
    expect(filtered.files).toEqual(['a.ts']);

    const ci = await grep({ pattern: 'hello', case_insensitive: true }, ws);
    if (ci.type !== 'files_with_matches') return;
    expect(ci.files.sort()).toEqual(['a.ts', 'b.md']);

    const exact = await grep({ pattern: 'hello' }, ws);
    if (exact.type !== 'files_with_matches') return;
    expect(exact.files).toEqual([]);
  });

  it('head_limit 截断 + offset 分页, 两页无重叠', async () => {
    const ws = makeDir();
    for (let i = 0; i < 30; i++) {
      write(path.join(ws, `f${String(i).padStart(2, '0')}.ts`), `const x = ${i}`);
    }

    const page1 = await grep({ pattern: 'const x', head_limit: 10 }, ws);
    const page2 = await grep({ pattern: 'const x', head_limit: 10, offset: 10 }, ws);
    if (page1.type !== 'files_with_matches' || page2.type !== 'files_with_matches') return;

    expect(page1.files.length).toBe(10);
    expect(page1.truncated).toBe(true);
    expect(page2.files.length).toBe(10);
    const overlap = page1.files.filter((f) => page2.files.includes(f));
    expect(overlap.length).toBe(0);

    const model1 = GrepTool.mapResultToModelContent!(page1);
    expect(String(model1)).toContain('offset=10');
  });

  it('validateInput: 路径不存在 → invalid; UNC 与省略 path → valid', () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'), 'x');
    const invocation = makeInvocation();

    expect(
      GrepTool.validateInput!({ pattern: 'x', path: 'nope' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(false);
    expect(
      GrepTool.validateInput!({ pattern: 'x', path: '\\\\server\\share' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(true);
    expect(
      GrepTool.validateInput!({ pattern: 'x' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(true);
  });
});
