// builtin 直扫测试:扫描出 descriptor、损坏跳过、源缺失降级空数组。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanBuiltinSkills } from '../sources/builtin.js';

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\nversion: 1.0.0\ndescription: ${name} desc\n---\n# ${name}\n`;

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ema-skill-builtin-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rootWithSkill(name: string): string {
  const root = makeDir();
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), SKILL_MD(name));
  return root;
}

describe('scanBuiltinSkills', () => {
  it('直扫内置目录产出 builtin 描述符;源内容变化下次扫描直接生效', async () => {
    const root = rootWithSkill('code-review');

    const first = await scanBuiltinSkills({ builtinRoot: root });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      name: 'code-review',
      scope: 'builtin',
      path: join(root, 'code-review', 'SKILL.md'),
    });

    // 源里再加一个技能,下次扫描直接看到(无物化层)。
    mkdirSync(join(root, 'tdd'), { recursive: true });
    writeFileSync(join(root, 'tdd', 'SKILL.md'), SKILL_MD('tdd'));
    const second = await scanBuiltinSkills({ builtinRoot: root });
    expect(second.map(d => d.path).sort()).toEqual([
      join(root, 'code-review', 'SKILL.md'),
      join(root, 'tdd', 'SKILL.md'),
    ].sort());
  });

  it('损坏技能跳过,不影响其他技能', async () => {
    const root = rootWithSkill('good');
    mkdirSync(join(root, 'broken'), { recursive: true }); // 无 SKILL.md

    const result = await scanBuiltinSkills({ builtinRoot: root });
    expect(result.map(d => d.path)).toEqual([join(root, 'good', 'SKILL.md')]);
  });

  it('源不存在 → 降级空数组,不抛', async () => {
    const result = await scanBuiltinSkills({ builtinRoot: join(makeDir(), 'missing') });
    expect(result).toEqual([]);
  });
});
