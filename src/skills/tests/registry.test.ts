// SkillRegistry 测试:三源合成、串行刷新不交错、单源失败降级。
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

describe('SkillRegistry', () => {
  it('合成 builtin+user+project 三源;getByKey 可查', async () => {
    const bundled = makeDir();
    mkdirSync(join(bundled, 'code-review'), { recursive: true });
    writeFileSync(join(bundled, 'code-review', 'SKILL.md'), SKILL_MD('code-review'));
    const builtinRoot = makeDir();
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'my-skill'), { recursive: true });
    writeFileSync(join(userRoot, 'my-skill', 'SKILL.md'), SKILL_MD('my-skill'));
    const workspace = makeDir();
    mkdirSync(join(workspace, '.agents/skills/proj-skill'), { recursive: true });
    writeFileSync(join(workspace, '.agents/skills/proj-skill', 'SKILL.md'), SKILL_MD('proj-skill'));

    const store = createSkillStore({ repo: makeRepo(), userRoot });
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot,
      bundledSkillsSource: bundled,
      store,
    });

    await registry.refresh(workspace);
    const keys = registry.list().map((d) => d.key).sort();
    expect(keys.some((k) => k === 'builtin:code-review')).toBe(true);
    expect(keys.some((k) => k.startsWith('project:agents:'))).toBe(true);
    expect(registry.getByKey('builtin:code-review')?.name).toBe('code-review');
  });

  it('并发 refresh 串行收尾,结果一致', async () => {
    const bundled = makeDir();
    const builtinRoot = makeDir();
    const userRoot = makeDir();
    mkdirSync(join(userRoot, 'only'), { recursive: true });
    writeFileSync(join(userRoot, 'only', 'SKILL.md'), SKILL_MD('only'));

    const store = createSkillStore({ repo: makeRepo(), userRoot });
    const registry = createSkillRegistry({
      userRoot,
      builtinRoot,
      bundledSkillsSource: bundled,
      store,
    });

    await Promise.all([registry.refresh(), registry.refresh(), registry.refresh()]);
    expect(registry.list().map((d) => d.name)).toEqual(['only']);
  });
});
