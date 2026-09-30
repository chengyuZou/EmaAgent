// baseline 基线机制:ensure/reset/diff 在真实临时仓库上的行为。
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diffSinceBaseline,
  ensureBaseline,
  hasUsableBaseline,
  resetBaseline,
} from '../index.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-git-baseline-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!HAS_GIT)('baseline', () => {
  it('ensureBaseline 建立可用基线,首次 diff 为空', async () => {
    const root = await tempRepo();
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'a.md'), 'hello', 'utf8');
    await fs.writeFile(path.join(root, 'sub', 'b.md'), 'world', 'utf8');

    await ensureBaseline(root);
    expect(await hasUsableBaseline(root)).toBe(true);

    const diff = await diffSinceBaseline(root);
    expect(diff.changes).toEqual([]);
    expect(diff.unifiedDiff.trim()).toBe('');
    expect(diff.truncated).toBe(false);
  });

  it('空 Memory 目录也能建立基线', async () => {
    const root = await tempRepo();
    await ensureBaseline(root);
    expect(await hasUsableBaseline(root)).toBe(true);
    expect(await diffSinceBaseline(root)).toMatchObject({
      changes: [], unifiedDiff: '', truncated: false, omittedFiles: 0,
    });
  });

  it('新增/修改/删除后 diff 报出完整 changes 与 unified diff(含 untracked)', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'a.md'), 'hello', 'utf8');
    await ensureBaseline(root);

    // modified: tracked 文件
    await fs.writeFile(path.join(root, 'a.md'), 'hello2', 'utf8');
    // added: untracked 文件
    await fs.writeFile(path.join(root, 'new.md'), 'brand new', 'utf8');
    // deleted: 基线里没有这个文件,先建再删一个 tracked 的
    await fs.writeFile(path.join(root, 'gone.md'), 'bye', 'utf8');
    await git(root, ['add', 'gone.md']);
    await git(root, ['commit', '-q', '-m', 'add gone']);
    // 基线已含 gone.md?没有——基线在 ensureBaseline 时建的,之后 commit 是用户动作,不属于基线。
    // 为保证"deleted"出现:把当前 HEAD 作为新基线前先删一个文件并走 diff。
    await fs.rm(path.join(root, 'gone.md'));

    const diff = await diffSinceBaseline(root);
    const byPath = new Map(diff.changes.map((c) => [c.path, c.status]));
    expect(byPath.get('a.md')).toBe('modified');
    expect(byPath.get('new.md')).toBe('added');
    expect(byPath.get('gone.md')).toBe('deleted');

    expect(diff.unifiedDiff).toContain('diff --git a/a.md b/a.md');
    expect(diff.unifiedDiff).toContain('diff --git a/new.md b/new.md');
    expect(diff.unifiedDiff).toContain('diff --git a/gone.md b/gone.md');
    expect(diff.truncated).toBe(false);
  });

  it('resetBaseline 后 diff 归零(单 commit 折叠)', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'a.md'), 'v1', 'utf8');
    await ensureBaseline(root);

    await fs.writeFile(path.join(root, 'a.md'), 'v2', 'utf8');
    await fs.writeFile(path.join(root, 'b.md'), 'added', 'utf8');
    expect((await diffSinceBaseline(root)).changes.length).toBeGreaterThan(0);

    await resetBaseline(root);
    const after = await diffSinceBaseline(root);
    expect(after.changes).toEqual([]);
    expect(after.unifiedDiff.trim()).toBe('');

    // 单 commit:git log 只有 1 条(amend 折叠)
    const count = Number(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    );
    expect(count).toBe(1);
  });

  it('maxDiffBytes 触发截断,changes 仍完整', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'a.md'), 'hello', 'utf8');
    await ensureBaseline(root);

    const big = 'x'.repeat(5000);
    await fs.writeFile(path.join(root, 'big.md'), big, 'utf8');

    const diff = await diffSinceBaseline(root, { maxDiffBytes: 1024 });
    expect(diff.truncated).toBe(true);
    expect(diff.changes.map((c) => c.path)).toEqual(['big.md']);
    expect(Buffer.byteLength(diff.unifiedDiff, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('变化文件过多时快探跳过 unified diff,changes 仍完整', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'a.md'), 'hello', 'utf8');
    await ensureBaseline(root);

    // 201 个 untracked 文件 → 超过 MAX_CHANGES_FOR_UNIFIED(200)
    for (let i = 0; i < 201; i++) {
      await fs.writeFile(path.join(root, `f${String(i).padStart(3, '0')}.md`), `content-${i}`, 'utf8');
    }

    const diff = await diffSinceBaseline(root);
    expect(diff.unifiedSkipped).toBe(true);
    expect(diff.unifiedDiff).toBe('');
    expect(diff.changes).toHaveLength(201);
    expect(diff.changes.every((c) => c.status === 'added')).toBe(true);
  });

  it('文件清单和 patch 都按基线到磁盘的最终变化, 不叠加暂存中间状态', async () => {
    const root = await tempRepo();
    await fs.writeFile(path.join(root, 'a.md'), 'original\n');
    await ensureBaseline(root);
    await fs.writeFile(path.join(root, 'a.md'), 'staged\n');
    git(root, ['add', 'a.md']);
    await fs.writeFile(path.join(root, 'a.md'), 'original\n');
    expect(await diffSinceBaseline(root)).toMatchObject({ changes: [], unifiedDiff: '' });
  });

  it('重命名按删除和新增表达, 路径不经过 trim 或手写 porcelain 解析', async () => {
    const root = await tempRepo();
    const oldPath = ' old 中文.md';
    const newPath = ' new 中文.md';
    await fs.writeFile(path.join(root, oldPath), 'original\n');
    await ensureBaseline(root);
    await fs.rename(path.join(root, oldPath), path.join(root, newPath));
    git(root, ['add', '-A']);
    const diff = await diffSinceBaseline(root);
    expect(diff.changes).toEqual(expect.arrayContaining([
      { status: 'deleted', path: oldPath },
      { status: 'added', path: newPath },
    ]));
    expect(diff.changes).toHaveLength(2);
    expect(diff.unifiedDiff).toContain('deleted file mode');
    expect(diff.unifiedDiff).toContain('new file mode');
  });

  it('Memory 正文可超过审查的 200 万字符上限, 字节截断仍保留完整字符和清单', async () => {
    const root = await tempRepo();
    await ensureBaseline(root);
    await fs.writeFile(path.join(root, 'large.md'), '修改'.repeat(1_100_000));
    await fs.writeFile(path.join(root, 'other.md'), 'small\n');
    const full = await diffSinceBaseline(root, { maxDiffBytes: 8 * 1024 * 1024 });
    expect(full.truncated).toBe(false);
    expect(full.unifiedDiff.length).toBeGreaterThan(2_000_000);
    const limited = await diffSinceBaseline(root, { maxDiffBytes: 257 });
    expect(limited.truncated).toBe(true);
    expect(limited.unifiedDiff).not.toContain('\uFFFD');
    expect(Buffer.byteLength(limited.unifiedDiff, 'utf8')).toBeLessThanOrEqual(257);
    expect(limited.changes).toHaveLength(2);
  });
});
