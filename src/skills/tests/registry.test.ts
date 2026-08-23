// SkillRegistry 测试：core 装载、project 按工作区现扫与隔离、串行刷新不交错、首装等待。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillRow, SkillsRepo } from '@ema-agent/storage';
import { createSkillRegistry } from '../registry.js';
import { createSkillStore } from '../store.js';

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\nversion: 1.0.0\ndescription: ${name} desc\n---\n# ${name}\n`;

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skill-registry-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRepo() {
  const rows = new Map<string, SkillRow>();
  const repo: SkillsRepo = {
    upsertById: (row) => { rows.set(row.id, { ...row }); },
    findById: (id) => rows.get(id) ?? null,
    listAll: () => [...rows.values()],
    listBySite: (siteId) => [...rows.values()].filter((r) => r.site_id === siteId),
    deleteById: (id) => { rows.delete(id); },
  } as SkillsRepo;
  return repo;
}

function makeWorkspace(skillName: string): string {
  const workspace = makeDir();
  mkdirSync(join(workspace, '.agents/skills', skillName), { recursive: true });
  writeFileSync(join(workspace, '.agents/skills', skillName, 'SKILL.md'), SKILL_MD(skillName));
  return workspace;
}

describe('SkillRegistry', () => {
  it('refreshCore 装载 builtin+user；list 按工作区附带 project', async () => {
    const bundled = makeDir();
    mkdirSync(join(bundled, 'code-review'), { recursive: true });
    writeFileSync(join(bundled, 'code-review', 'SKILL.md'), SKILL_MD('code-review'));
    const builtinRoot = makeDir();
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'my-skill'), { recursive: true });
    writeFileSync(join(userRoot, 'my-skill', 'SKILL.md'), SKILL_MD('my-skill'));
    const workspace = makeWorkspace('proj-skill');

    const store = createSkillStore({ repo: makeRepo(), userRoot });
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot,
      bundledSkillsSource: bundled,
      store,
    });

    await registry.refreshCore();
    // 不带工作区：只有 builtin+user
    const coreKeys = (await registry.list()).map((d) => d.key);
    expect(coreKeys).toContain('builtin:code-review');
    expect(coreKeys.some((k) => k.startsWith('project:'))).toBe(false);
    // 带工作区：合成 project
    const keys = (await registry.list(workspace)).map((d) => d.key);
    expect(keys.some((k) => k.startsWith('project:agents:'))).toBe(true);
    expect((await registry.getByKey('builtin:code-review'))?.name).toBe('code-review');
  });

  it('不同工作区的 project 技能互不覆盖', async () => {
    const userRoot = makeDir();
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot: makeDir(),
      bundledSkillsSource: makeDir(),
      store: createSkillStore({ repo: makeRepo(), userRoot }),
    });
    await registry.refreshCore();
    const wsA = makeWorkspace('skill-a');
    const wsB = makeWorkspace('skill-b');

    const keysA = (await registry.list(wsA)).map((d) => d.name);
    const keysB = (await registry.list(wsB)).map((d) => d.name);
    expect(keysA).toContain('skill-a');
    expect(keysA).not.toContain('skill-b');
    expect(keysB).toContain('skill-b');
    expect(keysB).not.toContain('skill-a');
  });

  it('并发 refreshCore 串行收尾,结果一致', async () => {
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'only'), { recursive: true });
    writeFileSync(join(userRoot, 'only', 'SKILL.md'), SKILL_MD('only'));

    const registry = createSkillRegistry({
      userRoot,
      builtinRoot: makeDir(),
      bundledSkillsSource: makeDir(),
      store: createSkillStore({ repo: makeRepo(), userRoot }),
    });

    await Promise.all([registry.refreshCore(), registry.refreshCore(), registry.refreshCore()]);
    expect((await registry.list()).map((d) => d.name)).toEqual(['only']);
  });

  it('list 等待进行中的首次装载，不读到空目录', async () => {
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'late'), { recursive: true });
    writeFileSync(join(userRoot, 'late', 'SKILL.md'), SKILL_MD('late'));

    const registry = createSkillRegistry({
      userRoot,
      builtinRoot: makeDir(),
      bundledSkillsSource: makeDir(),
      store: createSkillStore({ repo: makeRepo(), userRoot }),
    });

    // 不 await refreshCore，直接 list：必须等到首装完成。
    const pending = registry.refreshCore();
    const names = (await registry.list()).map((d) => d.name);
    await pending;
    expect(names).toEqual(['late']);
  });
});
