// 测试 Skill Catalog 的确定性排序、单项截断和总上下文预算。

import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_CATALOG_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  renderSkillCatalog,
} from '../runner.js';

describe('renderSkillCatalog', () => {
  it('稳定排序并限制单项描述', () => {
    const catalog = renderSkillCatalog([
      { name: 'zeta', description: 'z'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 50) },
      { name: 'alpha', description: 'first' },
    ]);

    expect(catalog.indexOf('**alpha**')).toBeLessThan(catalog.indexOf('**zeta**'));
    expect(catalog).toContain(`${'z'.repeat(MAX_SKILL_DESCRIPTION_CHARS - 1)}…`);
  });

  it('限制目录总长度并说明省略数量', () => {
    const catalog = renderSkillCatalog([
      ...Array.from({ length: 100 }, (_, index) => ({
        name: `skill-${String(index).padStart(3, '0')}`,
        description: '说明'.repeat(100),
      })),
    ]);

    expect(catalog.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(catalog).toContain('个技能未列出');
  });
});
