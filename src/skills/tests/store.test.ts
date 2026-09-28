// 验证真实 SQLite 和技能目录上的分来源对账, 启停, 安装删除及 004 开关搬运.
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, SkillsRepo } from '@ema-agent/storage';
import { SkillStore, STAGING_PREFIX } from '../store.js';

const SKILL_MD = (name: string, version = '1.0.0') =>
  `---\nname: ${name}\nversion: ${version}\ndescription: ${name} desc\n---\n# ${name}\n`;

const dirs: string[] = [];
const databases: Database[] = [];
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skill-store-'));
  dirs.push(dir);
  return dir;
}

function makeDatabase(): Database {
  const db = new Database({ memory: true, kind: 'profile' });
  databases.push(db);
  return db;
}

function makeStore(userRoot = makeRoot(), builtinRoot = makeRoot()) {
  const db = makeDatabase();
  db.migrate();
  return { store: new SkillStore(db, userRoot, builtinRoot), repo: new SkillsRepo(db.sqlite) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeSkill(root: string, dirName: string, name: string, version = '1.0.0'): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(name, version));
  return dir;
}

describe('SkillStore 目录对账', () => {
  it('无 version 时保存 NULL, 不伪造展示版本', async () => {
    const root = makeRoot();
    const dir = join(root, 'unversioned');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: unversioned\ndescription: 无版本技能\n---\n# 用法\n');
    const { store, repo } = makeStore(root);

    const result = await store.reconcileUserRoot();

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('version');
    expect(repo.listByScope('user')[0]?.version).toBeNull();
  });

  it('新增目录入索引, 消失目录连同开关删除, 损坏目录不影响其他技能', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    writeSkill(root, 'beta', 'beta');
    mkdirSync(join(root, 'broken'));
    const { store, repo } = makeStore(root);

    const first = await store.reconcileUserRoot();
    expect(first.map(e => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(repo.listByScope('user')).toHaveLength(2);

    const betaPath = join(root, 'beta', 'SKILL.md');
    store.setEnabled(betaPath, false);
    rmSync(join(root, 'beta'), { recursive: true });
    const second = await store.reconcileUserRoot();
    expect(second.map(e => e.name)).toEqual(['alpha']);
    expect(repo.findByPath(betaPath)).toBeNull();
    expect(store.listDisabledPaths()).toEqual([]);
  });

  it('手放目录改名更换路径身份, 旧索引被清理', async () => {
    const root = makeRoot();
    const dir = writeSkill(root, 'gamma', 'gamma');
    const { store, repo } = makeStore(root);
    await store.reconcileUserRoot();

    renameSync(dir, join(root, 'gamma-renamed'));
    await store.reconcileUserRoot();

    expect(repo.findByPath(join(root, 'gamma', 'SKILL.md'))).toBeNull();
    expect(repo.listByScope('user').map(row => row.path)).toEqual([join(root, 'gamma-renamed', 'SKILL.md')]);
  });

  it('元数据更新保留 enabled 和 installed_at, 重新启用也能落库', async () => {
    const root = makeRoot();
    const dir = writeSkill(root, 'alpha', 'alpha');
    const skillPath = join(dir, 'SKILL.md');
    const { store, repo } = makeStore(root);
    await store.reconcileUserRoot();
    const firstAt = repo.findByPath(skillPath)!.installed_at;
    store.setEnabled(skillPath, false);
    writeFileSync(skillPath, SKILL_MD('renamed', '2.0.0'));

    await store.reconcileUserRoot();

    expect(repo.findByPath(skillPath)).toMatchObject({
      name: 'renamed', version: '2.0.0', enabled: 0, installed_at: firstAt,
    });
    expect(store.listDisabledPaths()).toEqual([skillPath]);
    store.setEnabled(skillPath, true);
    expect(repo.findByPath(skillPath)?.enabled).toBe(1);
    expect(store.listDisabledPaths()).toEqual([]);
  });

  it('已有目录解析失败不清除其开关, 修复后继续沿用', async () => {
    const root = makeRoot();
    const dir = writeSkill(root, 'alpha', 'alpha');
    const skillPath = join(dir, 'SKILL.md');
    const { store, repo } = makeStore(root);
    await store.reconcileUserRoot();
    store.setEnabled(skillPath, false);
    writeFileSync(skillPath, 'broken');

    expect(await store.reconcileUserRoot()).toEqual([]);
    expect(repo.findByPath(skillPath)?.enabled).toBe(0);
    writeFileSync(skillPath, SKILL_MD('alpha'));
    expect(await store.reconcileUserRoot()).toHaveLength(1);
    expect(store.listDisabledPaths()).toEqual([skillPath]);
  });

  it('user 与 builtin 对账互不清理另一来源的索引和开关', async () => {
    const userRoot = makeRoot();
    const builtinRoot = makeRoot();
    const userPath = join(writeSkill(userRoot, 'user', 'user'), 'SKILL.md');
    const builtinPath = join(writeSkill(builtinRoot, 'builtin', 'builtin'), 'SKILL.md');
    const { store, repo } = makeStore(userRoot, builtinRoot);
    await store.reconcileUserRoot();
    await store.reconcileBuiltinRoot();
    store.setEnabled(builtinPath, false);
    store.setEnabled(userPath, false);

    await store.reconcileUserRoot();
    await store.reconcileBuiltinRoot();

    expect(repo.findByPath(userPath)).toMatchObject({ scope: 'user', enabled: 0 });
    expect(repo.findByPath(builtinPath)).toMatchObject({ scope: 'builtin', enabled: 0 });
    expect(store.listDisabledPaths().sort()).toEqual([userPath, builtinPath].sort());
  });
});

describe('SkillStore 安装与删除', () => {
  it('staging 落位写入 user 索引, 删除后不留目录和开关', async () => {
    const root = makeRoot();
    const { store, repo } = makeStore(root);
    const staging = writeSkill(root, `${STAGING_PREFIX}test-1`, 'PDFQA', '1.2.0');

    const descriptor = await store.finalizeInstall(staging, 'pdf-qa');

    expect(descriptor.path).toBe(join(root, 'pdf-qa', 'SKILL.md'));
    expect(existsSync(descriptor.path)).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(repo.findByPath(descriptor.path)?.scope).toBe('user');
    store.setEnabled(descriptor.path, false);
    await store.deleteUserSkill(descriptor.path);
    expect(existsSync(join(root, 'pdf-qa'))).toBe(false);
    expect(repo.listByScope('user')).toEqual([]);
    expect(store.listDisabledPaths()).toEqual([]);
  });

  it('替换安装保留原开关与安装时间', async () => {
    const root = makeRoot();
    const { store, repo } = makeStore(root);
    const first = await store.finalizeInstall(writeSkill(root, `${STAGING_PREFIX}one`, 'PDFQA'), 'pdf-qa');
    const firstAt = repo.findByPath(first.path)!.installed_at;
    store.setEnabled(first.path, false);

    await store.finalizeInstall(writeSkill(root, `${STAGING_PREFIX}two`, 'PDFQA', '2.0.0'), 'pdf-qa');

    expect(repo.findByPath(first.path)).toMatchObject({ version: '2.0.0', enabled: 0, installed_at: firstAt });
  });

  it('builtin 删除只删本地技能目录, 保留根目录和 user 技能', async () => {
    const userRoot = makeRoot();
    const builtinRoot = makeRoot();
    const builtinPath = join(writeSkill(builtinRoot, 'review', 'review'), 'SKILL.md');
    const userPath = join(writeSkill(userRoot, 'custom', 'custom'), 'SKILL.md');
    const { store, repo } = makeStore(userRoot, builtinRoot);
    await store.reconcileBuiltinRoot();
    await store.reconcileUserRoot();
    store.setEnabled(builtinPath, false);

    await store.deleteBuiltinSkill(builtinPath);
    await store.reconcileBuiltinRoot();

    expect(existsSync(builtinRoot)).toBe(true);
    expect(existsSync(builtinPath)).toBe(false);
    expect(repo.listByScope('builtin')).toEqual([]);
    expect(existsSync(userPath)).toBe(true);
    expect(repo.findByPath(userPath)?.scope).toBe('user');
    expect(store.listDisabledPaths()).toEqual([]);
  });

  it('两类删除入口不接受另一来源, SQL 行指向根目录外时拒绝删除', async () => {
    const userRoot = makeRoot();
    const builtinRoot = makeRoot();
    const builtinPath = join(writeSkill(builtinRoot, 'review', 'review'), 'SKILL.md');
    const userPath = join(writeSkill(userRoot, 'custom', 'custom'), 'SKILL.md');
    const outsidePath = join(writeSkill(makeRoot(), 'outside', 'outside'), 'SKILL.md');
    const { store, repo } = makeStore(userRoot, builtinRoot);
    await store.reconcileBuiltinRoot();
    await store.reconcileUserRoot();

    await expect(store.deleteUserSkill(builtinPath)).rejects.toThrow('此入口只能删除用户技能');
    await expect(store.deleteBuiltinSkill(userPath)).rejects.toThrow('此入口只能删除内置技能');
    repo.upsert({ ...repo.findByPath(userPath)!, path: outsidePath, dir_path: join(outsidePath, '..') });
    await expect(store.deleteUserSkill(outsidePath)).rejects.toThrow('escapes configured root');
    expect(existsSync(outsidePath)).toBe(true);
  });

  it('未知路径不能产生脱离技能索引的启停记录', () => {
    const { store } = makeStore();
    expect(() => store.setEnabled('missing', false)).toThrow('Skill "missing" not found');
    expect(store.listDisabledPaths()).toEqual([]);
  });

  it('孤儿 staging 被清扫, 正常目录不受影响', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    mkdirSync(join(root, `${STAGING_PREFIX}orphan`));
    const { store } = makeStore(root);

    await store.sweepOrphanStaging();

    expect(readdirSync(root)).toEqual(['alpha']);
  });
});

describe('profile 004 开关迁移', () => {
  it('保留 user 数据和全部旧开关, builtin 修复后搬入, 搬完删除迁移表', async () => {
    const db = makeDatabase();
    for (const file of ['001_initial.sql', '002_provider_seeds.sql', '003_remove_compact_output_tokens.sql']) {
      db.sqlite.exec(readFileSync(new URL(`../../storage/migrations/profile/${file}`, import.meta.url), 'utf8'));
    }
    db.sqlite.pragma('user_version = 3');
    const userRoot = makeRoot();
    const builtinRoot = makeRoot();
    const userDir = writeSkill(userRoot, 'custom', 'custom');
    const userPath = join(userDir, 'SKILL.md');
    const builtinPath = join(writeSkill(builtinRoot, 'review', 'review'), 'SKILL.md');
    const brokenDir = join(builtinRoot, 'broken');
    mkdirSync(brokenDir);
    const brokenPath = join(brokenDir, 'SKILL.md');
    db.sqlite.prepare(`
      INSERT INTO skills (path, name, version, description, dir_path, size_bytes, installed_at)
      VALUES (?, 'custom', '1.0.0', 'custom desc', ?, 100, 123)
    `).run(userPath, userDir);
    const oldToggle = db.sqlite.prepare('INSERT INTO skill_enablement (skill_path, enabled) VALUES (?, ?)');
    oldToggle.run(userPath, 0);
    oldToggle.run(builtinPath, 0);
    oldToggle.run(brokenPath, 0);
    db.sqlite.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('keep-me', '42', 1)").run();

    db.migrate();
    const repo = new SkillsRepo(db.sqlite);
    expect(db.currentVersion()).toBe(4);
    expect(repo.findByPath(userPath)).toMatchObject({ scope: 'user', enabled: 0, installed_at: 123 });
    expect(db.sqlite.prepare("SELECT value_json FROM settings WHERE key = 'keep-me'").pluck().get()).toBe('42');
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'skill_enablement'").get()).toBeUndefined();

    const store = new SkillStore(db, userRoot, builtinRoot);
    await Promise.all([store.reconcileUserRoot(), store.reconcileBuiltinRoot()]);
    expect(store.listDisabledPaths().sort()).toEqual([userPath, builtinPath].sort());
    expect(db.sqlite.prepare('SELECT skill_path FROM skill_enablement_migration').pluck().all()).toEqual([brokenPath]);

    // 搬完的开关不再从旧记录恢复, 后续用户的新选择优先.
    store.setEnabled(builtinPath, true);
    writeFileSync(brokenPath, SKILL_MD('broken'));
    await store.reconcileBuiltinRoot();
    expect(store.listDisabledPaths().sort()).toEqual([userPath, brokenPath].sort());
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'skill_enablement_migration'").get()).toBeUndefined();
    await store.reconcileUserRoot();
    await store.reconcileBuiltinRoot();
    expect(repo.findByPath(builtinPath)?.enabled).toBe(1);
  });
});
