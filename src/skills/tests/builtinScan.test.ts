// builtin 物化与扫描测试:指纹对账(匹配跳过/不匹配重写)、损坏降级、descriptor 形状。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function sourceWithSkill(name: string): string {
  const source = makeDir();
  mkdirSync(join(source, name), { recursive: true });
  writeFileSync(join(source, name, 'SKILL.md'), SKILL_MD(name));
  return source;
}

describe('scanBuiltinSkills — 物化对账', () => {
  it('首轮物化并扫描出 builtin 描述符;次轮指纹匹配跳过物化', async () => {
    const source = sourceWithSkill('code-review');
    const target = makeDir();

    const first = await scanBuiltinSkills({ bundledSource: source, materializedRoot: target });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      key: 'builtin:code-review',
      name: 'code-review',
      scope: 'builtin',
    });
    // marker 已写。
    const marker = JSON.parse(
      readFileSync(join(target, '.ema-skill-marker.json'), 'utf8'),
    ) as { fingerprint: string };
    expect(marker.fingerprint.length).toBeGreaterThan(0);

    // 在物化目录里做个手工改动;指纹匹配时次轮不得重写(改动保留)。
    writeFileSync(join(target, 'code-review', 'manual.txt'), 'keep');
    const second = await scanBuiltinSkills({ bundledSource: source, materializedRoot: target });
    expect(second).toHaveLength(1);
    // 文件仍在说明没有重写。
    expect(readFileSync(join(target, 'code-review', 'manual.txt'), 'utf8')).toBe('keep');
  });

  it('源内容变化后指纹不匹配 → 整目录重写', async () => {
    const source = sourceWithSkill('code-review');
    const target = makeDir();

    await scanBuiltinSkills({ bundledSource: source, materializedRoot: target });
    // 源里再加一个技能 → 指纹变化 → 重写。
    mkdirSync(join(source, 'tdd'), { recursive: true });
    writeFileSync(join(source, 'tdd', 'SKILL.md'), SKILL_MD('tdd'));

    const result = await scanBuiltinSkills({ bundledSource: source, materializedRoot: target });
    expect(result.map((d) => d.key).sort()).toEqual(['builtin:code-review', 'builtin:tdd']);
  });

  it('源不存在 → 降级空数组,不抛', async () => {
    const target = makeDir();
    const result = await scanBuiltinSkills({
      bundledSource: join(target, 'missing-source'),
      materializedRoot: target,
    });
    expect(result).toEqual([]);
  });
});
