// SKILL.md 的解析与有界读取:frontmatter 校验、正文提取、体积上限。
import { readFile, stat } from 'node:fs/promises';
import matter from 'gray-matter';
import {
  MAX_SKILL_BYTES,
  SkillFrontmatterSchema,
  type SkillManifest,
} from './types.js';

/** 把 SKILL.md 字符串解析成 SkillManifest;frontmatter 缺失或无效时抛描述性错误。 */
export function parseSkillMd(rawMd: string): SkillManifest {
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

/** 返回 { ok, error } 不抛错——供 UI 校验用。 */
export function validateSkillMd(rawMd: string): { ok: true; manifest: SkillManifest } | { ok: false; error: string } {
  try {
    const manifest = parseSkillMd(rawMd);
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 有界读取 SKILL.md:先 stat 再读,超限直接报错而不是读爆内存。
 * 技能内容来自不可信站点,任何读盘点都必须过这个口。
 */
export async function readSkillFileBounded(
  filePath: string,
  maxBytes: number = MAX_SKILL_BYTES,
): Promise<string> {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new Error(`SKILL.md 超过体积上限(${info.size} > ${maxBytes} bytes): ${filePath}`);
  }
  return readFile(filePath, 'utf8');
}
