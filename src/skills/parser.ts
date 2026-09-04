// 解析 SKILL.md frontmatter 与正文,只产出 Skills 域真实消费的字段。
import matter from 'gray-matter';
import {
  SkillFrontmatterSchema,
  type ParsedSkillMd,
} from './types.js';

export function parseSkillMd(rawMd: string): ParsedSkillMd {
  const { data, content } = matter(rawMd);

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
    version:      fm.version,
    description:  fm.description,
    whenToUse:    fm['when-to-use'],
    // allowed-tools 在 EmaAgent 这里作为建议工具使用 不做Tool过滤
    suggestedTools: fm['allowed-tools'] ?? [],
    body:         content.trim(),
  };
}
