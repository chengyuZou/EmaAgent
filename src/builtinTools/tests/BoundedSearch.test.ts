// 测试搜索子进程与 Glob/Grep 会在记录数、字节数和时间预算处停止生产。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type {
  ToolExecutionScope,
  ToolInvocationContext,
} from '@ema-agent/tools';
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

    const result = await GlobTool.unsafeExecute(
      { pattern: '*.txt' },
      ...makeContext(directory),
    ) as { files: string[]; truncated: boolean; notice?: string };

    expect(result.files).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('Search stopped');
  });

  it.skipIf(!hasRipgrep)('Grep 按 head_limit 截断并提示模型缩小范围', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(
      path.join(directory, 'many.txt'),
      Array.from({ length: 300 }, (_, index) => `match-${index}`).join('\n'),
      'utf8',
    );

    const result = await GrepTool.unsafeExecute(
      {
        pattern: 'match-',
        output_mode: 'content',
        case_insensitive: false,
        head_limit: 10,
      },
      ...makeContext(directory),
    ) as { output: string; truncated: boolean; stopReason?: string };

    expect(result.truncated).toBe(true);
    expect(result.stopReason).toBe('records');
    expect(result.output).toContain('Use a narrower pattern');
  });

  it.skipIf(!hasRipgrep)('Grep 把以短横线开头的 pattern 当作内容而不是 rg 参数', async () => {
    const directory = makeTempDir();
    fs.writeFileSync(path.join(directory, 'literal.txt'), '--files\nordinary', 'utf8');

    const result = await GrepTool.unsafeExecute(
      {
        pattern: '--files',
        output_mode: 'content',
        case_insensitive: false,
        head_limit: 10,
      },
      ...makeContext(directory),
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
): [ToolInvocationContext, ToolExecutionScope] {
  return [{
    sessionId: asSessionId('session-test'),
    turnId: asTurnId('turn-test'),
    toolCallId: asToolCallId('search-call'),
    workspaceRoot,
    signal: new AbortController().signal,
  }, {
    readFileState: new Map(),
  }];
}
