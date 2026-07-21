import matter from 'gray-matter';
import { SkillFrontmatterSchema, type SkillManifest } from './types.js';

// ── parseSkillMd ─────────────────────────────────────────────────────────────
//
// 把 SKILL.md 字符串解析成 SkillManifest。
// frontmatter 缺失或无效时抛描述性错误。

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
    allowedTools: fm['allowed-tools'] ?? [],
    body:         content.trim(),
  };
}

// ── validateSkillMd ──────────────────────────────────────────────────────────
//
// 返回 { ok, error } 不抛错 - 供 UI 校验用。

export function validateSkillMd(rawMd: string): { ok: true; manifest: SkillManifest } | { ok: false; error: string } {
  try {
    const manifest = parseSkillMd(rawMd);
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
