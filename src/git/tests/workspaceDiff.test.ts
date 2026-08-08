// 测试 patch 分段解析与 gitWorkspaceDiff 在真实临时仓库上的双 scope、untracked 伪 diff 与计数。
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitWorkspaceDiff } from '../index.js';
import { parseGitDiffSections } from '../diff.js';

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

describe('parseGitDiffSections', () => {
  it('识别修改/新增/删除/重命名并计数', () => {
    const patch = [
      'diff --git a/mod.txt b/mod.txt',
      'index 111..222 100644',
      '--- a/mod.txt',
      '+++ b/mod.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old.txt b/renamed.txt',
      'similarity index 90%',
      'rename from old.txt',
      'rename to renamed.txt',
      '--- a/old.txt',
      '+++ b/renamed.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');

    const sections = parseGitDiffSections(patch);
    expect(sections).toHaveLength(4);
    expect(sections[0]).toMatchObject({ path: 'mod.txt', status: 'modified', additions: 1, deletions: 1 });
    expect(sections[1]).toMatchObject({ path: 'new.txt', status: 'added', additions: 2, deletions: 0 });
    expect(sections[2]).toMatchObject({ path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 });
    expect(sections[3]).toMatchObject({ path: 'renamed.txt', status: 'renamed', additions: 1, deletions: 1 });
  });

  it('空 patch 与无标记段', () => {
    expect(parseGitDiffSections('')).toEqual([]);
    expect(parseGitDiffSections('garbage without header\n')).toEqual([]);
  });
});

describe.skipIf(!HAS_GIT)('gitWorkspaceDiff(真实临时仓库)', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-diff-'));
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(root, 'tracked.txt'), 'line1\nline2\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'init']);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('非仓库目录裁决为 not-a-repo', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-diff-out-'));
    try {
      expect(await gitWorkspaceDiff(outside)).toEqual({ capability: 'not-a-repo' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('未暂存含修改与未跟踪,已暂存独立计数', async () => {
    await fs.writeFile(path.join(root, 'tracked.txt'), 'line1\nchanged\n');
    await fs.writeFile(path.join(root, 'staged-new.txt'), 'staged\n');
    git(root, ['add', 'staged-new.txt']);
    await fs.writeFile(path.join(root, 'loose.txt'), 'untracked\n');

    const result = await gitWorkspaceDiff(root);
    expect(result.capability).toBe('ok');
    if (result.capability !== 'ok') return;

    const unstagedPaths = result.unstaged.files.map((f) => `${f.path}:${f.status}`).sort();
    expect(unstagedPaths).toEqual(['loose.txt:added', 'tracked.txt:modified']);
    const tracked = result.unstaged.files.find((f) => f.path === 'tracked.txt');
    expect(tracked).toMatchObject({ additions: 1, deletions: 1, truncated: false });
    expect(tracked?.unifiedDiff).toContain('+changed');
    const loose = result.unstaged.files.find((f) => f.path === 'loose.txt');
    expect(loose).toMatchObject({ additions: 1, deletions: 0 });
    expect(loose?.absolutePath).toBe(path.join(root, 'loose.txt'));

    expect(result.staged.files.map((f) => `${f.path}:${f.status}`)).toEqual(['staged-new.txt:added']);
    expect(result.staged.totalAdditions).toBe(1);
  });

  it('干净仓库双 scope 为空且 omittedFiles 为 0', async () => {
    const clean = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-diff-clean-'));
    try {
      git(clean, ['init', '-b', 'main']);
      git(clean, ['config', 'user.email', 'test@example.com']);
      git(clean, ['config', 'user.name', 'Test']);
      await fs.writeFile(path.join(clean, 'a.txt'), 'a\n');
      git(clean, ['add', 'a.txt']);
      git(clean, ['commit', '-m', 'init']);
      const result = await gitWorkspaceDiff(clean);
      expect(result.capability).toBe('ok');
      if (result.capability !== 'ok') return;
      expect(result.staged).toMatchObject({ files: [], omittedFiles: 0 });
      expect(result.unstaged).toMatchObject({ files: [], omittedFiles: 0 });
    } finally {
      await fs.rm(clean, { recursive: true, force: true });
    }
  });
});
