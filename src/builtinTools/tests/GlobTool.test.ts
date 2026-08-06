// GlobTool 收口测试: 基本匹配、path 限定、mtime 排序、结果上限截断、相对化、
// map 投影(空/非空/截断)、validateInput(不存在/非目录/UNC)。
// 注意: 本机有 rg 时走 rgGlob; 无 rg 时同一套用例自动走 nodeGlob 兜底。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { GlobTool, type GlobResult } from '../tools/GlobTool/GlobTool.js';

// 临时目录统一登记, 每个用例结束清理。
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-glob-'));
  tempDirs.push(dir);
  return dir;
}

function makeInvocation(): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000f1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000f2'),
    toolCallId: asToolCallId('call-glob-1'),
    signal: new AbortController().signal,
  };
}

function write(filePath: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function setMtime(filePath: string, ms: number): void {
  fs.utimesSync(filePath, new Date(ms), new Date(ms));
}

async function glob(
  input: { pattern: string; path?: string },
  workspaceRoot: string,
): Promise<GlobResult> {
  return GlobTool.execute(input, { workspaceRoot }, makeInvocation());
}

describe('GlobTool — 匹配与投影', () => {
  it('按模式枚举文件, 结果相对工作区返回', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'));
    write(path.join(ws, 'sub', 'b.ts'));
    write(path.join(ws, 'c.txt'));

    const result = await glob({ pattern: '**/*.ts' }, ws);

    expect(result.files.sort()).toEqual(['a.ts', 'sub/b.ts']);
    expect(result.truncated).toBe(false);
  });

  it('无匹配时返回空列表, map 投影为 No files found', async () => {
    const ws = makeDir();
    write(path.join(ws, 'a.ts'));

    const result = await glob({ pattern: '**/*.md' }, ws);

    expect(result.files).toEqual([]);
    expect(GlobTool.mapResultToModelContent!(result)).toBe('No files found');
  });

  it('path 限定子目录, 结果仍相对工作区根(可直接回填 Read/Edit)', async () => {
    const ws = makeDir();
    write(path.join(ws, 'src', 'a.ts'));
    write(path.join(ws, 'docs', 'b.ts'));

    const result = await glob({ pattern: '**/*.ts', path: 'src' }, ws);

    expect(result.files).toEqual(['src/a.ts']);
  });

  it('按 mtime 降序(最近修改在前), 同时间按路径决胜', async () => {
    const ws = makeDir();
    const a = path.join(ws, 'a.ts');
    const b = path.join(ws, 'b.ts');
    write(a);
    write(b);
    setMtime(a, 1000);
    setMtime(b, 2000);

    const result = await glob({ pattern: '**/*.ts' }, ws);

    expect(result.files[0]).toBe('b.ts');
    expect(result.files[1]).toBe('a.ts');
  });

  it('超过 100 条结果截断, map 投影带截断提示', async () => {
    const ws = makeDir();
    for (let i = 0; i < 120; i++) {
      write(path.join(ws, `f${String(i).padStart(3, '0')}.ts`), 'x');
    }

    const result = await glob({ pattern: '**/*.ts' }, ws);

    expect(result.files.length).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('120');
    const modelContent = GlobTool.mapResultToModelContent!(result);
    expect(String(modelContent).split('\n').length).toBe(101); // 100 行文件 + 1 行截断提示
    expect(String(modelContent)).toContain('truncated');
  });

  it('validateInput: 目录不存在/不是目录 → invalid; UNC 与省略 path → valid', () => {
    const ws = makeDir();
    write(path.join(ws, 'f.ts'));
    const invocation = makeInvocation();

    expect(
      GlobTool.validateInput!({ pattern: '**/*', path: 'nope' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(false);
    expect(
      GlobTool.validateInput!({ pattern: '**/*', path: 'f.ts' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(false);
    expect(
      GlobTool.validateInput!({ pattern: '**/*', path: '\\\\server\\share' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(true);
    expect(
      GlobTool.validateInput!({ pattern: '**/*' }, { workspaceRoot: ws }, invocation).valid,
    ).toBe(true);
  });
});
