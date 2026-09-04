// SkillRegistry 测试：core 装载、project 工作区缓存与隔离、串行刷新不交错、首装等待。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillEnablementRepo, SkillRow, SkillsRepo } from '@ema-agent/storage';
import { createSkillRegistry } from '../registry.js';
import { createSkillStore } from '../sources/user.js';

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
    upsert: row => { rows.set(row.path, { ...row }); },
    findByPath: path => rows.get(path) ?? null,
    listAll: () => [...rows.values()],
    deleteByPath: path => { rows.delete(path); },
  } as SkillsRepo;
  return repo;
}

function makeEnablement(): SkillEnablementRepo {
  const states = new Map<string, boolean>();
  return {
    listDisabledPaths: () => [...states.entries()].filter(([, enabled]) => !enabled).map(([path]) => path),
    setEnabled: (path: string, enabled: boolean) => { states.set(path, enabled); },
    deleteByPath: (path: string) => { states.delete(path); },
  } as SkillEnablementRepo;
}

function makeWorkspace(skillName: string): string {
  const workspace = makeDir();
  mkdirSync(join(workspace, '.agents/skills', skillName), { recursive: true });
  writeFileSync(join(workspace, '.agents/skills', skillName, 'SKILL.md'), SKILL_MD(skillName));
  return workspace;
}

describe('SkillRegistry', () => {
  it('refreshCore 装载 builtin+user；list 按工作区附带 project', async () => {
    const builtinRoot = makeDir();
    mkdirSync(join(builtinRoot, 'code-review'), { recursive: true });
    writeFileSync(join(builtinRoot, 'code-review', 'SKILL.md'), SKILL_MD('code-review'));
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'my-skill'), { recursive: true });
    writeFileSync(join(userRoot, 'my-skill', 'SKILL.md'), SKILL_MD('my-skill'));
    const workspace = makeWorkspace('proj-skill');

    const store = createSkillStore({ repo: makeRepo(), enablement: makeEnablement(), userRoot });
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot,
      store,
    });

    await registry.refreshCore();
    // 不带工作区：只有 builtin+user
    const corePaths = (await registry.list()).map(d => d.path);
    expect(corePaths).toContain(join(builtinRoot, 'code-review', 'SKILL.md'));
    expect((await registry.list()).some(entry => entry.scope === 'project')).toBe(false);
    // 带工作区：合成 project
    const project = (await registry.list(workspace)).find(entry => entry.scope === 'project');
    expect(project?.projectSourceId).toBe('agents');
    expect((await registry.getByPath(join(builtinRoot, 'code-review', 'SKILL.md')))?.name).toBe('code-review');
  });

  it('不同工作区的 project 技能互不覆盖', async () => {
    const userRoot = makeDir();
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot: makeDir(),
      store: createSkillStore({ repo: makeRepo(), enablement: makeEnablement(), userRoot }),
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

  it('project 列表复用工作区缓存,显式刷新后替换缓存', async () => {
    const userRoot = makeDir();
    const workspace = makeWorkspace('before');
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot: makeDir(),
      store: createSkillStore({ repo: makeRepo(), enablement: makeEnablement(), userRoot }),
    });
    await registry.refreshCore();
    expect((await registry.list(workspace)).map(entry => entry.name)).toContain('before');

    mkdirSync(join(workspace, '.agents/skills', 'after'), { recursive: true });
    writeFileSync(join(workspace, '.agents/skills', 'after', 'SKILL.md'), SKILL_MD('after'));
    expect((await registry.list(workspace)).map(entry => entry.name)).not.toContain('after');

    await registry.refreshWorkspace(workspace);
    const refreshed = await registry.list(workspace);
    expect(refreshed.map(entry => entry.name)).toContain('after');
    expect((await registry.getByPath(join(workspace, '.agents/skills', 'after', 'SKILL.md')))?.name).toBe('after');
  });

  it('并发 refreshCore 串行收尾,结果一致', async () => {
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'only'), { recursive: true });
    writeFileSync(join(userRoot, 'only', 'SKILL.md'), SKILL_MD('only'));

    const registry = createSkillRegistry({
      userRoot,
      builtinRoot: makeDir(),
      store: createSkillStore({ repo: makeRepo(), enablement: makeEnablement(), userRoot }),
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
      store: createSkillStore({ repo: makeRepo(), enablement: makeEnablement(), userRoot }),
    });

    // 不 await refreshCore，直接 list：必须等到首装完成。
    const pending = registry.refreshCore();
    const names = (await registry.list()).map((d) => d.name);
    await pending;
    expect(names).toEqual(['late']);
  });
});
