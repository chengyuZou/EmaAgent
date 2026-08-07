// SkillStore 全链路测试:对账(新增/变更/消失/损坏跳过)、安装落位、删除守卫、孤儿清扫。
// 真实临时目录 + 内存 SkillsRepo 存根,不碰 SQLite。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillRow, SkillsRepo } from '@ema-agent/storage';
import { createSkillStore, STAGING_PREFIX, type SkillStore } from '../store.js';

const SKILL_MD = (name: string, version = '1.0.0') =>
  `---\nname: ${name}\nversion: ${version}\ndescription: ${name} desc\n---\n# ${name}\n`;

const dirs: string[] = [];
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skill-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeSkill(root: string, dirName: string, name: string, version = '1.0.0'): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(name, version));
  return dir;
}

/** 内存 SkillsRepo:行表存 Map,方法与真实 repo 同形。 */
function makeRepo() {
  const rows = new Map<string, SkillRow>();
  const repo: SkillsRepo = {
    upsertById: (row) => { rows.set(row.id, { ...row }); },
    findById: (id) => rows.get(id) ?? null,
    listAll: () => [...rows.values()],
    listBySite: (siteId) => [...rows.values()].filter((r) => r.site_id === siteId),
    deleteById: (id) => { rows.delete(id); },
  } as SkillsRepo;
  return { repo, rows };
}

describe('reconcileUserRoot', () => {
  it('新增目录入索引;消失目录删索引;损坏目录跳过不拖垮整轮', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    writeSkill(root, 'beta', 'beta');
    mkdirSync(join(root, 'broken'));  // 无 SKILL.md
    const { repo, rows } = makeRepo();
    const store = createSkillStore({ repo, userRoot: root });

    const first = await store.reconcileUserRoot();
    expect(first.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(first.skipped).toHaveLength(1);
    expect(rows.size).toBe(2);

    // beta 删除后应对账删除索引。
    rmSync(join(root, 'beta'), { recursive: true, force: true });
    const second = await store.reconcileUserRoot();
    expect(second.entries.map((e) => e.name)).toEqual(['alpha']);
    expect(rows.size).toBe(1);
  });

  it('手动放置目录改名 = 新技能(新 id),旧行被对账删除', async () => {
    const root = makeRoot();
    const dir = writeSkill(root, 'gamma', 'gamma');
    const { repo, rows } = makeRepo();
    const store = createSkillStore({ repo, userRoot: root });

    await store.reconcileUserRoot();
    const oldIds = [...rows.keys()];
    renameSync(dir, join(root, 'gamma-renamed'));
    await store.reconcileUserRoot();
    const newIds = [...rows.keys()];
    expect(newIds).not.toEqual(oldIds);
    expect(rows.size).toBe(1);
  });

  it('站点安装目录(site_ 前缀)的溯源在对账后保留', async () => {
    const root = makeRoot();
    writeSkill(root, 'site_shop_pdf-qa', 'PDFQA', '1.2.0');
    const { repo, rows } = makeRepo();
    const store = createSkillStore({ repo, userRoot: root });

    await store.reconcileUserRoot();
    const row = rows.get('site_shop_pdf-qa')!;
    expect(row.site_id).toBeNull();  // 首轮对账无溯源

    // 模拟安装时写入的溯源,再对账不得回退。
    rows.set(row.id, { ...row, site_id: 'shop', site_entry_id: 'pdf-qa', sha256: 'abc', source_url: 'https://x/y.zip', version: '9.9.9' });
    const result = await store.reconcileUserRoot();
    const kept = rows.get('site_shop_pdf-qa')!;
    expect(kept.site_id).toBe('shop');
    expect(kept.version).toBe('9.9.9');  // 站点索引版本不被 frontmatter 回写
    expect(result.entries[0]!.provenance).toMatchObject({ kind: 'site', siteId: 'shop' });
  });
});

describe('finalizeInstall / deleteUserSkill / sweepOrphanStaging', () => {
  it('staging 原子落位并写溯源;删除后目录与索引同清', async () => {
    const root = makeRoot();
    const { repo, rows } = makeRepo();
    const store = createSkillStore({ repo, userRoot: root });

    const staging = join(root, `${STAGING_PREFIX}test-1`);
    writeSkill(root, `${STAGING_PREFIX}test-1`, 'PDFQA', '1.2.0');

    const descriptor = await store.finalizeInstall(staging, {
      kind: 'site',
      siteId: 'shop',
      siteEntryId: 'pdf-qa',
      version: '1.2.0',
      bundleUrl: 'https://x/pdf-qa.zip',
      bundleSha256: 'deadbeef',
    });

    expect(descriptor.key).toBe('user:site_shop_pdf-qa');
    expect(existsSync(join(root, 'site_shop_pdf-qa', 'SKILL.md'))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(rows.get('site_shop_pdf-qa')).toMatchObject({ site_id: 'shop', sha256: 'deadbeef' });

    await store.deleteUserSkill(descriptor.key);
    expect(existsSync(join(root, 'site_shop_pdf-qa'))).toBe(false);
    expect(rows.size).toBe(0);
  });

  it('孤儿 staging 目录被清扫,正常目录不受影响', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    mkdirSync(join(root, `${STAGING_PREFIX}orphan`));
    const { repo } = makeRepo();
    const store = createSkillStore({ repo, userRoot: root });

    await store.sweepOrphanStaging();
    const remaining = readdirSync(root);
    expect(remaining).toEqual(['alpha']);
  });
});
