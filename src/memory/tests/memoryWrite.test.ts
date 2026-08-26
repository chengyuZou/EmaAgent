// 测试用户编辑正式记忆：白名单拒绝、mtime 冲突校验与新建/回写。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readMemoryFile,
  writeMemoryFile,
} from '../common/memoryFiles.js';
import {
  MemoryFileChangedError,
  MemoryFileNotEditableError,
} from '../errors.js';

async function temporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-write-'));
}

describe('writeMemoryFile', () => {
  it('写入已存在的正式文件并返回新 mtime', async () => {
    const root = await temporaryRoot();
    const full = path.join(root, 'work', 'MEMORY.md');
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '# 旧内容', 'utf8');

    const result = await writeMemoryFile(root, {
      path: 'work/MEMORY.md',
      content: '# 新内容\n',
    });

    expect(result.path).toBe('work/MEMORY.md');
    await expect(fs.readFile(full, 'utf8')).resolves.toBe('# 新内容\n');
    expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it('白名单内不存在的文件直接创建（父目录一并建）', async () => {
    const root = await temporaryRoot();
    const result = await writeMemoryFile(root, {
      path: 'work/topics/repo-rules.md',
      content: '仓库规则\n',
    });
    expect(result.path).toBe('work/topics/repo-rules.md');
    await expect(
      fs.readFile(path.join(root, 'work', 'topics', 'repo-rules.md'), 'utf8'),
    ).resolves.toBe('仓库规则\n');
  });

  it.each([
    'work/extensions/notes/n1.md',
    'work/turn_evidence/t1.md',
    'work/memory_summary.md',
    'work/.git/hooks/x.md',
    'work/notes.txt',
  ])('拒绝白名单外路径：%s', async (rel) => {
    const root = await temporaryRoot();
    await expect(writeMemoryFile(root, { path: rel, content: 'x' }))
      .rejects.toBeInstanceOf(MemoryFileNotEditableError);
  });

  it('拒绝越出 memory 根的路径', async () => {
    const root = await temporaryRoot();
    await expect(writeMemoryFile(root, { path: '../outside.md', content: 'x' }))
      .rejects.toBeInstanceOf(MemoryFileNotEditableError);
  });

  it('baseMtimeMs 与盘上不一致时报 MemoryFileChangedError', async () => {
    const root = await temporaryRoot();
    const full = path.join(root, 'work', 'MEMORY.md');
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, 'v1', 'utf8');

    const before = await readMemoryFile(root, { path: 'work/MEMORY.md' });
    expect(before).toBeDefined();

    // 模拟整合 Job 在读取之后改写
    await fs.writeFile(full, 'v2', 'utf8');
    const after = await fs.stat(full);

    await expect(writeMemoryFile(root, {
      path: 'work/MEMORY.md',
      content: 'user edit',
      baseMtimeMs: before!.mtimeMs,
    })).rejects.toBeInstanceOf(MemoryFileChangedError);

    // 用最新 mtime 则放行
    const result = await writeMemoryFile(root, {
      path: 'work/MEMORY.md',
      content: 'user edit',
      baseMtimeMs: after.mtimeMs,
    });
    expect(result.path).toBe('work/MEMORY.md');
    await expect(fs.readFile(full, 'utf8')).resolves.toBe('user edit');
  });
});
