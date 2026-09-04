// SkillStore 全链路测试:对账(新增/变更/消失/损坏跳过)、安装落位、删除守卫、孤儿清扫。
// 真实临时目录 + 内存存根 repo,不碰 SQLite。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillEnablementRepo, SkillRow, SkillsRepo } from '@ema-agent/storage';
import { createSkillStore, STAGING_PREFIX } from '../sources/user.js';

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
    upsert: row => { rows.set(row.path, { ...row }); },
    findByPath: path => rows.get(path) ?? null,
    listAll: () => [...rows.values()],
    deleteByPath: path => { rows.delete(path); },
  } as unknown as SkillsRepo;
  return { repo, rows };
}

/** 内存 SkillEnablementRepo:启停行存 Map。 */
function makeEnablement() {
  const states = new Map<string, boolean>();
  const enablement = {
    listDisabledPaths: () => [...states.entries()].filter(([, enabled]) => !enabled).map(([path]) => path),
    setEnabled: (path: string, enabled: boolean) => { states.set(path, enabled); },
    deleteByPath: (path: string) => { states.delete(path); },
  } as SkillEnablementRepo;
  return { enablement, states };
}

describe('reconcileUserRoot', () => {
  it('新增目录入索引;消失目录删索引并连带清启停行;损坏目录跳过不拖垮整轮', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    writeSkill(root, 'beta', 'beta');
    mkdirSync(join(root, 'broken'));  // 无 SKILL.md
    const { repo, rows } = makeRepo();
    const { enablement, states } = makeEnablement();
    const store = createSkillStore({ repo, enablement, userRoot: root });

    const first = await store.reconcileUserRoot();
    expect(first.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(first.skipped).toHaveLength(1);
    expect(rows.size).toBe(2);

    // beta 被禁用后目录消失:索引与启停行同清。
    const betaPath = first.entries.find(e => e.name === 'beta')!.path;
    enablement.setEnabled(betaPath, false);
    rmSync(join(root, 'beta'), { recursive: true, force: true });
    const second = await store.reconcileUserRoot();
    expect(second.entries.map((e) => e.name)).toEqual(['alpha']);
    expect(rows.size).toBe(1);
    expect(states.size).toBe(0);
  });

  it('手动放置目录改名 = 新技能(新 id),旧行被对账删除', async () => {
    const root = makeRoot();
    const dir = writeSkill(root, 'gamma', 'gamma');
    const { repo, rows } = makeRepo();
    const store = createSkillStore({ repo, enablement: makeEnablement().enablement, userRoot: root });

    await store.reconcileUserRoot();
    const oldIds = [...rows.keys()];
    renameSync(dir, join(root, 'gamma-renamed'));
    await store.reconcileUserRoot();
    const newIds = [...rows.keys()];
    expect(newIds).not.toEqual(oldIds);
    expect(rows.size).toBe(1);
  });

  it('再次对账保留 installed_at(对账不应重置安装时间)', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    const { repo, rows } = makeRepo();
    const store = createSkillStore({ repo, enablement: makeEnablement().enablement, userRoot: root });

    await store.reconcileUserRoot();
    const firstAt = [...rows.values()][0]!.installed_at;
    await store.reconcileUserRoot();
    expect([...rows.values()][0]!.installed_at).toBe(firstAt);
  });
});

describe('finalizeInstall / deleteUserSkill / sweepOrphanStaging', () => {
  it('staging 原子落位并写索引;删除后目录、索引与启停行同清', async () => {
    const root = makeRoot();
    const { repo, rows } = makeRepo();
    const { enablement, states } = makeEnablement();
    const store = createSkillStore({ repo, enablement, userRoot: root });

    const staging = join(root, `${STAGING_PREFIX}test-1`);
    writeSkill(root, `${STAGING_PREFIX}test-1`, 'PDFQA', '1.2.0');

    const descriptor = await store.finalizeInstall(staging, 'pdf-qa');

    expect(descriptor.path).toBe(join(root, 'pdf-qa', 'SKILL.md'));
    expect(existsSync(join(root, 'pdf-qa', 'SKILL.md'))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(rows.size).toBe(1);

    // 禁用后删除:启停行不得残留(同名技能再放回不应幽灵复活为禁用)。
    enablement.setEnabled(descriptor.path, false);
    await store.deleteUserSkill(descriptor.path);
    expect(existsSync(join(root, 'pdf-qa'))).toBe(false);
    expect(rows.size).toBe(0);
    expect(states.size).toBe(0);
  });

  it('孤儿 staging 目录被清扫,正常目录不受影响', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha', 'alpha');
    mkdirSync(join(root, `${STAGING_PREFIX}orphan`));
    const { repo } = makeRepo();
    const store = createSkillStore({ repo, enablement: makeEnablement().enablement, userRoot: root });

    await store.sweepOrphanStaging();
    const remaining = readdirSync(root);
    expect(remaining).toEqual(['alpha']);
  });
});
