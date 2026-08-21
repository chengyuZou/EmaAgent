// 验证模型可读 Memory 文件的范围、搜索语义、分页与取消。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listMemoryFiles,
  readMemoryFile,
  searchMemoryFiles,
} from '../common/memoryFiles.js';

describe('Memory 文件读搜', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-files-'));
    await fs.mkdir(path.join(root, 'work', 'topics'), { recursive: true });
    await fs.mkdir(path.join(root, 'work', 'turn_evidence'), { recursive: true });
    await fs.mkdir(path.join(root, 'work', 'extensions', 'notes'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'work', 'topics', 'typescript.md'),
      'Use D:\\Github\\EmaAgent\nsecond line\nthird line',
      'utf8',
    );
    await fs.writeFile(path.join(root, 'work', 'memory_summary.md'), 'internal', 'utf8');
    await fs.writeFile(path.join(root, 'work', 'turn_evidence', 'turn.md'), 'internal', 'utf8');
    await fs.writeFile(path.join(root, 'work', 'extensions', 'notes', 'note.md'), 'internal', 'utf8');
  });

  afterEach(async () => {
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

  it('根目录可列举，但派生证据、便签和摘要不对模型暴露', async () => {
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
  });
});
