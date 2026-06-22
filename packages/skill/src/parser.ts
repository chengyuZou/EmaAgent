import matter from 'gray-matter';
import { SkillFrontmatterSchema, type SkillManifest } from './types.js';

// ── parseSkillMd ─────────────────────────────────────────────────────────────
//
// Parses a SKILL.md string into a SkillManifest.
// Throws a descriptive error if frontmatter is missing or invalid.

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
// Returns { ok, error } without throwing — useful for UI validation.

export function validateSkillMd(rawMd: string): { ok: true; manifest: SkillManifest } | { ok: false; error: string } {
  try {
    const manifest = parseSkillMd(rawMd);
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
