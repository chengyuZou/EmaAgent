// applyPatch:unified diff 应用 / preflight / 冲突 / revert 行为。
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPatch, extractPathsFromDiff } from '../index.js';

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

const tmpRoots: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-apply-'));
  tmpRoots.push(dir);
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.name', 'test']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('extractPathsFromDiff', () => {
  it('解析修改/新增/删除/重命名路径', () => {
    const patch = [
      'diff --git a/mod.txt b/mod.txt',
      '--- a/mod.txt',
      '+++ b/mod.txt',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'diff --git a/old.txt b/renamed.txt',
      'similarity index 90%',
      '',
    ].join('\n');
    expect(extractPathsFromDiff(patch).sort()).toEqual([
      'gone.txt',
      'mod.txt',
      'new.txt',
      'old.txt',
      'renamed.txt',
    ]);
  });
});

describe.skipIf(!HAS_GIT)('applyPatch', () => {
  it('应用修改+新增,revert 后还原', async () => {
    const cwd = await tempRepo();
    await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\n', 'utf8');
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-q', '-m', 'init']);

    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+hello2',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+added',
      '',
    ].join('\n');

    const result = await applyPatch({ cwd, diff: patch });
    expect(result.exitCode).toBe(0);
    expect(result.appliedPaths.sort()).toEqual(['a.txt', 'new.txt']);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('hello2\n');
    expect(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).toBe('added\n');

    // revert 还原
    const reverted = await applyPatch({ cwd, diff: patch, revert: true });
    expect(reverted.exitCode).toBe(0);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('hello\n');
    await expect(fs.stat(path.join(cwd, 'new.txt'))).rejects.toThrow();
  });

  it('preflight 不落盘', async () => {
    const cwd = await tempRepo();
    await fs.writeFile(path.join(cwd, 'a.txt'), 'hello\n', 'utf8');
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-q', '-m', 'init']);

    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+hello2',
      '',
    ].join('\n');

    const result = await applyPatch({ cwd, diff: patch, preflight: true });
    expect(result.exitCode).toBe(0);
    expect(result.appliedPaths).toEqual(['a.txt']);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('hello\n');
  });

  it('上下文不匹配 → 冲突/失败,不抛异常', async () => {
    const cwd = await tempRepo();
    await fs.writeFile(path.join(cwd, 'a.txt'), 'zzz\n', 'utf8');
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-q', '-m', 'init']);

    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+hello2',
      '',
    ].join('\n');

    const result = await applyPatch({ cwd, diff: patch });
    expect(result.exitCode).toBe(1);
    expect(result.conflictedPaths).toContain('a.txt');
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('zzz\n');
  });
});
