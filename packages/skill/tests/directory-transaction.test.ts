// 这里测试未完成的 Skill 目录切换会按 journal 恢复旧版本.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recoverSkillDirectoryTransactions,
  SkillDirectoryTransaction,
} from '../src/directory-transaction.js';

let rootPath: string;

beforeEach(async () => {
  rootPath = await mkdtemp(join(tmpdir(), 'ema-skill-transaction-'));
});

afterEach(async () => {
  await rm(rootPath, { recursive: true, force: true });
});

describe('SkillDirectoryTransaction', () => {
  it('activated 但未更新索引时恢复旧目录', async () => {
    const finalPath = join(rootPath, 'demo');
    await mkdir(finalPath);
    await writeFile(join(finalPath, 'SKILL.md'), 'old', 'utf8');

    const transaction = await SkillDirectoryTransaction.create(rootPath, 'demo');
    await writeFile(join(transaction.stagePath, 'SKILL.md'), 'new', 'utf8');
    await transaction.prepare(finalPath, finalPath);
    await transaction.activate();

    expect(await readFile(join(finalPath, 'SKILL.md'), 'utf8')).toBe('new');
    expect(await recoverSkillDirectoryTransactions(rootPath)).toEqual([]);
    expect(await readFile(join(finalPath, 'SKILL.md'), 'utf8')).toBe('old');
  });

  it('索引已更新时保留新目录并清理 backup', async () => {
    const finalPath = join(rootPath, 'demo');
    await mkdir(finalPath);
    await writeFile(join(finalPath, 'SKILL.md'), 'old', 'utf8');

    const transaction = await SkillDirectoryTransaction.create(rootPath, 'demo');
    await writeFile(join(transaction.stagePath, 'SKILL.md'), 'new', 'utf8');
    await transaction.prepare(finalPath, finalPath);
    await transaction.activate();
    await transaction.markIndexed();

    expect(await recoverSkillDirectoryTransactions(rootPath)).toEqual([]);
    expect(await readFile(join(finalPath, 'SKILL.md'), 'utf8')).toBe('new');
  });

  it('rename 后还没写 activated marker 的崩溃也能幂等恢复', async () => {
    const finalPath = join(rootPath, 'demo');
    await mkdir(finalPath);
    await writeFile(join(finalPath, 'SKILL.md'), 'old', 'utf8');

    const transaction = await SkillDirectoryTransaction.create(rootPath, 'demo');
    await writeFile(join(transaction.stagePath, 'SKILL.md'), 'new', 'utf8');
    await transaction.prepare(finalPath, finalPath);
    await transaction.activate();
    const marker = (await readdir(rootPath)).find(name => name.endsWith('.activated'))!;
    await rm(join(rootPath, marker));

    expect(await recoverSkillDirectoryTransactions(rootPath)).toEqual([]);
    expect(await recoverSkillDirectoryTransactions(rootPath)).toEqual([]);
    expect(await readFile(join(finalPath, 'SKILL.md'), 'utf8')).toBe('old');
  });
});
