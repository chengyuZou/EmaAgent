// 验证用户选定范围的 Memory 清除语义.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearAllMemory,
  clearMemoryDirectory,
  clearMemoryFiles,
} from '../common/clearMemory.js';

async function temporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-clear-'));
}

describe('Memory clear operations', () => {
  it('clears all contents while keeping the Memory root', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'work', 'topics'), { recursive: true });
    await fs.writeFile(path.join(root, 'work', 'MEMORY.md'), 'work', 'utf8');
    await fs.writeFile(path.join(root, 'work', 'topics', 'git.md'), 'git', 'utf8');

    await clearAllMemory(root);

    expect(await fs.readdir(root)).toEqual([]);
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  });

  it('clears only the selected directory and keeps the directory itself', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'work', 'topics'), { recursive: true });
    await fs.mkdir(path.join(root, 'relationship'), { recursive: true });
    await fs.writeFile(path.join(root, 'work', 'topics', 'git.md'), 'git', 'utf8');
    await fs.writeFile(path.join(root, 'relationship', 'MEMORY.md'), 'chat', 'utf8');

    await clearMemoryDirectory(root, path.join('work', 'topics'));

    expect(await fs.readdir(path.join(root, 'work', 'topics'))).toEqual([]);
    expect(await fs.readFile(path.join(root, 'relationship', 'MEMORY.md'), 'utf8'))
      .toBe('chat');
  });

  it('removes only selected files and treats missing files as already clear', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'work'), { recursive: true });
    await fs.writeFile(path.join(root, 'work', 'MEMORY.md'), 'memory', 'utf8');
    await fs.writeFile(path.join(root, 'work', 'keep.md'), 'keep', 'utf8');

    await clearMemoryFiles(root, [
      path.join('work', 'MEMORY.md'),
      path.join('work', 'missing.md'),
    ]);

    await expect(fs.stat(path.join(root, 'work', 'MEMORY.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(root, 'work', 'keep.md'), 'utf8')).toBe('keep');
  });

  it('rejects paths outside the Memory root', async () => {
    const root = await temporaryRoot();

    await expect(clearMemoryDirectory(root, '..')).rejects.toBeInstanceOf(RangeError);
    await expect(clearMemoryFiles(root, [path.join('..', 'outside.md')]))
      .rejects.toBeInstanceOf(RangeError);
  });
});
