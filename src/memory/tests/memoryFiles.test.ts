// 验证模型可读 Memory 文件的范围、搜索语义、分页与取消。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listMemoryFiles,
  readMemoryFile,
  readMemoryPreviews,
  MEMORY_PREVIEW_BYTES,
  searchMemoryFiles,
} from '../common/memoryFiles.js';

describe('Memory 文件读搜', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-files-'));
    await fs.mkdir(path.join(root, 'work', 'topics'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'work', 'topics', 'typescript.md'),
      'Use D:\\Github\\EmaAgent\nsecond line\nthird line',
      'utf8',
    );
    await fs.writeFile(path.join(root, 'work', 'memory_summary.md'), 'internal', 'utf8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('默认从根搜索，并对查询与内容使用相同的归一化', async () => {
    const result = await searchMemoryFiles(root, {
      queries: ['d:/github/emaagent'],
      caseSensitive: false,
      normalized: true,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('work/topics/typescript.md');
  });

  it('根目录可列举，但注入摘要不对模型暴露', async () => {
    await expect(listMemoryFiles(root)).resolves.toMatchObject({
      entries: [{ path: 'work', entryType: 'directory' }],
    });
    const work = await listMemoryFiles(root, { path: 'work' });
    expect(work.entries).toEqual([{ path: 'work/topics', entryType: 'directory' }]);
  });

  it('maxLines 真正裁剪内容时如实标记 truncated', async () => {
    await expect(readMemoryFile(root, {
      path: 'work/topics/typescript.md',
      maxLines: 1,
    })).resolves.toMatchObject({
      content: 'Use D:\\Github\\EmaAgent',
      truncated: true,
    });
  });

  it('已取消的文件操作抛出取消原因，不伪装为成功结果', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(searchMemoryFiles(root, {
      queries: ['Use'],
      signal: controller.signal,
    })).rejects.toBe(reason);
    await expect(listMemoryFiles(root, { signal: controller.signal })).rejects.toBe(reason);
    await expect(readMemoryPreviews(root, controller.signal)).rejects.toBe(reason);
  });

  it('预览只读取开头, UTF-8 被截在中间时不补乱码, 完整文件读取不受影响', async () => {
    const prefix = 'x'.repeat(MEMORY_PREVIEW_BYTES - 1);
    await fs.writeFile(path.join(root, 'work', 'large.md'), `${prefix}中文\n${'正文\n'.repeat(50_000)}`);
    const readFile = vi.spyOn(fs, 'readFile');
    const previews = await readMemoryPreviews(root);
    expect(previews.find(file => file.path === 'work/large.md')).toEqual({
      path: 'work/large.md', content: prefix, truncated: true,
    });
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
    const full = await readMemoryFile(root, { path: 'work/large.md', maxLines: 1 });
    expect(full?.content.length).toBeGreaterThan(MEMORY_PREVIEW_BYTES);
  });

  it('按最近修改顺序取五个正式文件, 不限定轨道或角色, 不展示摘要和内部文件', async () => {
    const files = [
      'work/topics/old.md',
      'relationship/shared_user_memory.md',
      'work/MEMORY.md',
      'relationship/characters/艾玛/MEMORY.md',
      'work/topics/new.md',
      'relationship/characters/其他角色/MEMORY.md',
    ];
    await fs.utimes(path.join(root, 'work', 'topics', 'typescript.md'), 1, 1);
    for (const [index, relative] of files.entries()) {
      const filename = path.join(root, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, `# Memory ${index}\n正文`);
      await fs.utimes(filename, 100 + index, 100 + index);
    }
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'internal.md'), 'internal');
    await fs.writeFile(path.join(root, 'work', 'empty.md'), '');
    const previews = await readMemoryPreviews(root);
    expect(previews.map(file => file.path)).toEqual(files.slice(1).reverse());
    expect(previews.every(file => !file.truncated)).toBe(true);
  });
});
