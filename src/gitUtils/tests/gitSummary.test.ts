// 测试 shortstat/porcelain 解析与 gitSummary 在真实临时仓库上的能力裁决和统计。
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitSummary } from '../index.js';
import { parseShortStat } from '../queries/changeStats.js';
import { countUntracked } from '../queries/status.js';
import { findRepoRoot } from '../repoDetection.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('parseShortStat', () => {
  it('解析完整行', () => {
    expect(parseShortStat(' 3 files changed, 10 insertions(+), 2 deletions(-)'))
      .toEqual({ filesChanged: 3, insertions: 10, deletions: 2 });
  });

  it('缺省部分按 0 处理', () => {
    expect(parseShortStat(' 1 file changed, 5 insertions(+)'))
      .toEqual({ filesChanged: 1, insertions: 5, deletions: 0 });
    expect(parseShortStat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe('countUntracked', () => {
  it('只统计 ?? 行', () => {
    expect(countUntracked(' M src/a.ts\n?? src/b.ts\n?? README.md\nA  src/c.ts\n')).toBe(2);
    expect(countUntracked('')).toBe(0);
  });
});

describe.skipIf(!HAS_GIT)('gitSummary(真实临时仓库)', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-repo-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-outside-'));
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    git(root, ['add', 'a.txt']);
    git(root, ['commit', '-m', 'init']);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('非仓库目录裁决为 not-a-repo', async () => {
    expect(await findRepoRoot(outside)).toBeNull();
    expect(await gitSummary(outside)).toEqual({ capability: 'not-a-repo' });
  });

  it('子目录向上找到仓库根', async () => {
    const nested = path.join(root, 'sub', 'deep');
    await fs.mkdir(nested, { recursive: true });
    expect(await findRepoRoot(nested)).toBe(root);
  });

  it('干净仓库返回 ok 与零统计', async () => {
    const summary = await gitSummary(root);
    expect(summary).toEqual({
      capability: 'ok',
      repoRoot: root,
      branch: 'main',
      headShortSha: null,
      unstaged: { filesChanged: 0, insertions: 0, deletions: 0 },
      staged: { filesChanged: 0, insertions: 0, deletions: 0 },
      untrackedCount: 0,
      upstream: null,
      originUrl: null,
    });
  });

  it('配置 origin 后返回远端地址', async () => {
    git(root, ['remote', 'add', 'origin', 'https://example.com/ema/repo.git']);
    try {
      const summary = await gitSummary(root);
      expect(summary.capability).toBe('ok');
      if (summary.capability !== 'ok') return;
      expect(summary.originUrl).toBe('https://example.com/ema/repo.git');
    } finally {
      git(root, ['remote', 'remove', 'origin']);
    }
  });

  it('未暂存、已暂存与未跟踪分别计数', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\nworld\n');
    await fs.writeFile(path.join(root, 'staged.txt'), 'new\n');
    git(root, ['add', 'staged.txt']);
    await fs.writeFile(path.join(root, 'loose.txt'), 'untracked\n');

    const summary = await gitSummary(root);
    expect(summary.capability).toBe('ok');
    if (summary.capability !== 'ok') return;
    expect(summary.unstaged).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
    expect(summary.staged).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
    expect(summary.untrackedCount).toBe(1);
  });
});
