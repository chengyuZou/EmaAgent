// 这里测试共享 Scratchpad 的并发写、作者元数据和 append 总配额。
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listScratchpadEntries,
  readScratchpadEntry,
  writeScratchpadEntry,
} from '../tools/ScratchpadTool/ScratchpadStore.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-scratchpad-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ScratchpadStore', () => {
  it('同一个 key 的并发 append 不丢任何一段内容', async () => {
    const dir = await makeTempDir();
    await writeScratchpadEntry({
      dir,
      key: 'shared',
      value: 'start',
      append: false,
      author: 'main',
    });

    await Promise.all(Array.from({ length: 20 }, (_, index) => writeScratchpadEntry({
      dir,
      key: 'shared',
      value: `part-${index}`,
      append: true,
      author: `subagent:${index}`,
    })));

    const value = await readScratchpadEntry(dir, 'shared');
    expect(new Set(value?.split('\n'))).toEqual(new Set([
      'start',
      ...Array.from({ length: 20 }, (_, index) => `part-${index}`),
    ]));
  });

  it('并发写不同 key 时不会互相覆盖作者元数据', async () => {
    const dir = await makeTempDir();
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeScratchpadEntry({
      dir,
      key: `key_${index}`,
      value: `value-${index}`,
      append: false,
      author: `subagent:${index}`,
    })));

    const entries = await listScratchpadEntries(dir);
    expect(entries).toHaveLength(20);
    expect(new Map(entries.map((entry) => [entry.key, entry.author]))).toEqual(
      new Map(Array.from({ length: 20 }, (_, index) => [`key_${index}`, `subagent:${index}`])),
    );
  });

  it('append 使用最终完整值计算 8 MiB 总配额', async () => {
    const dir = await makeTempDir();
    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const filePath = path.join(dir, `base_${index}`);
      await fs.writeFile(filePath, '');
      await fs.truncate(filePath, 256 * 1024);
    }));
    await fs.writeFile(path.join(dir, 'filler'), '');
    await fs.truncate(path.join(dir, 'filler'), 250 * 1024);
    await fs.writeFile(path.join(dir, 'current'), '');
    await fs.truncate(path.join(dir, 'current'), 110 * 1024);
    await fs.writeFile(path.join(dir, 'extra'), '');
    await fs.truncate(path.join(dir, 'extra'), 30 * 1024);

    await expect(writeScratchpadEntry({
      dir,
      key: 'current',
      value: 'x'.repeat(145 * 1024),
      append: true,
      author: 'main',
    })).rejects.toThrow(/quota exceeded/i);
  });
});
