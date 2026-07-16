// 这里测试 Skill 安装, 升级回滚, slug 碰撞, 路径边界和重命名事务.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database, SkillsRepo } from '@ema-agent/storage';
import { SkillStore } from '../src/store.js';

let rootPath: string;
let database: Database;
let repo: SkillsRepo;
let store: SkillStore;

beforeEach(async () => {
  rootPath = await mkdtemp(join(tmpdir(), 'ema-skill-store-'));
  database = new Database({ memory: true, kind: 'profile' });
  database.migrate();
  repo = new SkillsRepo(database.sqlite);
  store = new SkillStore(repo, [{ path: rootPath, source: 'user' }]);
});

afterEach(async () => {
  database.close();
  await rm(rootPath, { recursive: true, force: true });
});

describe('SkillStore', () => {
  it('SQL 更新失败时恢复旧目录和旧正文', async () => {
    await store.install(skillMd('demo', 'old body'));
    vi.spyOn(repo, 'upsertByName').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(store.install(skillMd('demo', 'new body'))).rejects.toThrow('database unavailable');

    expect(await store.readRawMd('demo')).toContain('old body');
    expect((await readdir(rootPath)).filter(name => name.startsWith('.ema-skill-'))).toEqual([]);
  });

  it('不同名称映射到同一 slug 时拒绝覆盖已有 Skill', async () => {
    await store.install(skillMd('Foo Bar', 'first'));
    await expect(store.install(skillMd('foo-bar', 'second'))).rejects.toThrow('slug collision');
    expect(await store.readRawMd('Foo Bar')).toContain('first');
  });

  it.each([
    '../outside.txt',
    'scripts\\run.ps1',
    'CON/readme.txt',
    'assets/file. ',
    'SKILL.md',
  ])('拒绝无法跨平台安全落盘的 Bundle 路径: %s', async assetPath => {
    await expect(store.install(skillMd('unsafe', 'body'), {
      assets: { [assetPath]: new Uint8Array([1]) },
    })).rejects.toThrow();
    expect(await readdir(rootPath)).toEqual([]);
  });

  it('拒绝只在大小写敏感系统中看似不同的 asset 路径', async () => {
    await expect(store.install(skillMd('unsafe', 'body'), {
      assets: {
        'assets/Icon.png': new Uint8Array([1]),
        'assets/icon.png': new Uint8Array([2]),
      },
    })).rejects.toThrow('跨平台重名');
    expect(await readdir(rootPath)).toEqual([]);
  });

  it('数据库中的越界 dir_path 不能驱动递归删除', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ema-skill-outside-'));
    try {
      await writeFile(join(outside, 'SKILL.md'), skillMd('outside', 'keep me'), 'utf8');
      repo.upsertByName({
        id: 'outside-id',
        name: 'outside',
        version: '1.0.0',
        description: '',
        arg_hint: null,
        dir_path: outside,
        source: 'user',
        source_url: null,
        sha256: null,
        size_bytes: 1,
        enabled: 1,
        content_mtime: 1,
        installed_at: 1,
      });

      await expect(store.remove('outside')).rejects.toThrow('escapes configured root');
      expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toContain('keep me');
      expect(repo.findByName('outside')).not.toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('重命名同步切换目录, frontmatter 和 SQL 索引', async () => {
    await store.install(skillMd('Old Name', 'body'));
    await store.rename('Old Name', 'New Name');

    expect(store.findByName('Old Name')).toBeNull();
    const renamed = store.findByName('New Name');
    expect(renamed?.dirPath).toBe(join(rootPath, 'new-name'));
    expect(await store.readRawMd('New Name')).toContain('name: "New Name"');
    expect(await readdir(rootPath)).toEqual(['new-name']);
  });

  it('relocate 不能把 Skill 移到未配置目录', async () => {
    await store.install(skillMd('demo', 'body'));
    const outside = await mkdtemp(join(tmpdir(), 'ema-skill-target-'));
    try {
      await expect(store.relocate('demo', outside)).rejects.toThrow('configured writable root');
      expect(await store.readRawMd('demo')).toContain('body');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('扫描忽略事务内部目录, 不把 staging 当成 Skill', async () => {
    await mkdir(join(rootPath, '.ema-skill-stage-demo-orphan'));
    await writeFile(
      join(rootPath, '.ema-skill-stage-demo-orphan', 'SKILL.md'),
      skillMd('hidden', 'body'),
      'utf8',
    );

    const result = await store.scanAndReconcile();
    expect(result.indexed).toBe(0);
    expect(store.findByName('hidden')).toBeNull();
  });
});

function skillMd(name: string, body: string): string {
  return `---\nname: ${JSON.stringify(name)}\nversion: 1.0.0\ndescription: test\n---\n${body}\n`;
}
