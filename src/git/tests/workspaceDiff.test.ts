import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCompareDiff, gitWorkspaceDiff } from '../index.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!hasGit)('原生工作区差异', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-diff-'));
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'core.autocrlf', 'false']);
    await fs.writeFile(path.join(root, 'tracked.txt'), 'original\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('分别查询 HEAD→磁盘、HEAD→暂存区、暂存区→磁盘, 全部未提交不是两份 patch 拼接', async () => {
    await fs.writeFile(path.join(root, 'tracked.txt'), 'staged\n');
    git(root, ['add', 'tracked.txt']);
    await fs.writeFile(path.join(root, 'tracked.txt'), 'original\n');
    await fs.writeFile(path.join(root, 'loose.txt'), 'untracked\n');
    const [all, staged, unstaged] = await Promise.all([
      gitWorkspaceDiff(root, 'uncommitted'),
      gitWorkspaceDiff(root, 'staged'),
      gitWorkspaceDiff(root, 'unstaged'),
    ]);
    expect(all).not.toHaveProperty('status');
    expect(staged).not.toHaveProperty('status');
    expect(unstaged).not.toHaveProperty('status');
    if ('status' in all || 'status' in staged || 'status' in unstaged) {
      throw Error('Git query failed');
    }
    expect(all.patch).not.toContain('tracked.txt');
    expect(all.patch).toContain('b/loose.txt');
    expect(staged.patch).toContain('-original\n+staged');
    expect(staged.patch).not.toContain('loose.txt');
    expect(unstaged.patch).toContain('-staged\n+original');
    expect(unstaged.patch).toContain('b/loose.txt');
    expect(all.omittedFiles).toBe(0);
  });

  it('保留纯重命名、空文件、二进制和权限变化的原始头部, 不因没有 hunk 丢弃', async () => {
    await fs.rename(path.join(root, 'tracked.txt'), path.join(root, 'renamed.txt'));
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    git(root, ['add', '-A']);
    const result = await gitWorkspaceDiff(root, 'staged');
    if ('status' in result) {
      throw Error('Git query failed');
    }
    expect(result.patch).toContain('rename from tracked.txt\nrename to renamed.txt');
    expect(result.patch).toContain('diff --git a/empty.txt b/empty.txt\nnew file mode');
    expect(result.patch).toContain('Binary files');
    git(root, ['update-index', '--chmod=+x', 'renamed.txt']);
    const mode = await gitWorkspaceDiff(root, 'staged');
    if ('status' in mode) {
      throw Error('Git query failed');
    }
    expect(mode.patch).toContain('new mode 100755');
  });

  it('未跟踪清单保留前导空格和非 ASCII 路径, 空新文件也有原生 patch', async () => {
    await fs.writeFile(path.join(root, ' leading file.txt'), '++ incorrect-name\n');
    await fs.writeFile(path.join(root, '中文.txt'), '内容\n');
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    const result = await gitWorkspaceDiff(root, 'unstaged');
    if ('status' in result) {
      throw Error('Git query failed');
    }
    expect(result.omittedFiles).toBe(0);
    expect(result.patch).toContain('b/ leading file.txt');
    expect(result.patch).toContain('+++ incorrect-name');
    expect(result.patch).toContain('b/empty.txt');
    expect(result.patch).toContain('+内容');
  });

  it.each(['sha1', 'sha256'])('无 HEAD 的 %s 仓库使用 Git 计算的空树, 不硬编码摘要', async (format) => {
    const initial = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-initial-'));
    try {
      git(initial, ['init', '--object-format', format]);
      await fs.writeFile(path.join(initial, 'first.txt'), 'first\n');
      git(initial, ['add', 'first.txt']);
      await fs.writeFile(path.join(initial, 'first.txt'), 'final\n');
      const all = await gitWorkspaceDiff(initial, 'uncommitted');
      const staged = await gitWorkspaceDiff(initial, 'staged');
      expect(all).toMatchObject({
        omittedFiles: 0,
      });
      expect(staged).toMatchObject({
        omittedFiles: 0,
      });
      if ('status' in all || 'status' in staged) {
        throw Error('Git query failed');
      }
      expect(all.patch).toContain('+final');
      expect(staged.patch).toContain('+first');
    } finally {
      await fs.rm(initial, { recursive: true, force: true });
    }
  });

  it('不再逐文件截断, 原生总体输出超限才返回 diff-too-large', async () => {
    await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(210_000) + '\n');
    const accepted = await gitWorkspaceDiff(root, 'unstaged');
    expect(accepted).not.toHaveProperty('status');
    if ('status' in accepted) {
      throw Error('Git query failed');
    }
    expect(accepted.patch).not.toContain('diff 已截断');
    await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(2_000_001) + '\n');
    expect(await gitWorkspaceDiff(root, 'unstaged')).toEqual({ status: 'diff-too-large' });
  });

  it('compare 同样返回原生 patch, 不保留旧文件模型', async () => {
    const result = await gitCompareDiff(root, { kind: 'commit', sha: 'HEAD' });
    expect(result).not.toHaveProperty('status');
    if ('status' in result) {
      throw Error('Git query failed');
    }
    expect(result.patch).toContain('+original');
    expect(result).not.toHaveProperty('diff');
  });

  it('干净范围返回空 patch, 非仓库返回 not-a-repo', async () => {
    expect(await gitWorkspaceDiff(root, 'uncommitted')).toMatchObject({
      patch: '',
      omittedFiles: 0,
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-outside-'));
    try {
      expect(await gitWorkspaceDiff(outside, 'uncommitted')).toEqual({ status: 'not-a-repo' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
