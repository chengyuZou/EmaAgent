// 解析 SKILL.md frontmatter,只产出技能目录需要的字段。
import matter from 'gray-matter';
import {
  SkillFrontmatterSchema,
  type ParsedSkillMd,
} from './types.js';

export function parseSkillMd(rawMd: string): ParsedSkillMd {
  const { data } = matter(rawMd);

  const result = SkillFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid SKILL.md frontmatter:\n${issues}`);
  }

  const fm = result.data;
  return {
    name:         fm.name,
    ...(fm.version !== undefined ? { version: fm.version } : {}),
    description:  fm.description,
    whenToUse:    fm['when-to-use'],
  };
}
