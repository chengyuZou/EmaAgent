// 测试 Skill Catalog 的确定性排序、单项截断和总上下文预算。

import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_CATALOG_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  SkillRunner,
  renderSkillCatalog,
} from '../runner.js';

describe('renderSkillCatalog', () => {
  it('稳定排序并限制单项描述', () => {
    const catalog = renderSkillCatalog([
      summary('zeta', 'z'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 50)),
      summary('alpha', 'first'),
    ]);

    expect(catalog.indexOf('**alpha**')).toBeLessThan(catalog.indexOf('**zeta**'));
    expect(catalog).toContain(`${'z'.repeat(MAX_SKILL_DESCRIPTION_CHARS - 1)}…`);
  });

  it('限制目录总长度并说明省略数量', () => {
    const catalog = renderSkillCatalog([
      ...Array.from({ length: 100 }, (_, index) => ({
        skillId: `skill-${index}`,
        name: `skill-${String(index).padStart(3, '0')}`,
        version: '1.0.0',
        description: '说明'.repeat(100),
        path: `D:\\skills\\skill-${index}\\SKILL.md`,
        source: 'user' as const,
      })),
    ]);

    expect(catalog.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(catalog).toContain('个技能未列出');
  });
});

function summary(name: string, description: string) {
  return {
    skillId: `skill-${name}`,
    name,
    version: '1.0.0',
    description,
    path: `D:\\skills\\${name}\\SKILL.md`,
    source: 'user' as const,
  };
}

describe('SkillRunner Port', () => {
  it('不丢失 Skill 路径和 Bundle 身份', async () => {
    const activation = {
      skillId: 'skill-pdf',
      name: 'pdf',
      version: '1.0.0',
      source: 'user' as const,
      path: 'D:\\skills\\pdf\\SKILL.md',
      rootPath: 'D:\\skills\\pdf',
      bundleRevision: 'revision',
      instructions: '读取 PDF',
      allowedToolPatterns: ['FileRead', 'Grep'],
      files: [],
    };
    const runner = new SkillRunner({
      activate: async () => activation,
    } as never);

    await expect(runner.run('pdf', undefined)).resolves.toBe(activation);
  });
});
