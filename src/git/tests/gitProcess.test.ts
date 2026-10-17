import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitCommandError,
  GitOutputTooLargeError,
  toGitQueryFailure,
} from '../errors.js';
import { runGit } from '../gitProcess.js';

it('查询错误转换保留不认识的错误, 供调用方发现代码或文件系统问题', () => {
  const failure = new TypeError('unexpected input');
  expect(() => toGitQueryFailure(failure)).toThrow(failure);
});

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

describe.skipIf(!hasGit)('Git 进程错误', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-process-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('命令失败抛出具体错误, 查询转换后带上失败状态和命令信息', async () => {
    const failure: unknown = await runGit(root, ['--ema-invalid-option']).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitCommandError);
    expect(toGitQueryFailure(failure)).toMatchObject({
      status: 'error',
      message: expect.stringContaining('--ema-invalid-option'),
    });
  });

  it('真实输出超过缓冲限制时抛出输出超限错误', async () => {
    const failure: unknown = await runGit(root, ['--version'], { maxOutputBytes: 1 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitOutputTooLargeError);
    expect(toGitQueryFailure(failure)).toMatchObject({
      status: 'error',
      message: expect.stringContaining('output exceeded 1 bytes'),
    });
  });
});
