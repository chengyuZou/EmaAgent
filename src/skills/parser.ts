// SKILL.md 的解析:frontmatter 校验、正文提取。
import matter from 'gray-matter';
import {
  SkillFrontmatterSchema,
  type ParsedSkillMd,
} from './types.js';

/** 把 SKILL.md 字符串解析成 ParsedSkillMd;frontmatter 缺失或无效时抛描述性错误。 */
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
    argumentHint: fm['argument-hint'],
    whenToUse:    fm['when-to-use'],
    allowedTools: fm['allowed-tools'] ?? [],
    body:         content.trim(),
  };
}
