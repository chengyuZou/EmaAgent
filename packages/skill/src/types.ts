import { z } from 'zod';

// ── Activation modes ─────────────────────────────────────────────────────────

export const SkillActivateMode = z.enum(['chat', 'narrative', 'agent']);
export type SkillActivateMode = z.infer<typeof SkillActivateMode>;

// ── Frontmatter schema ───────────────────────────────────────────────────────

export const SkillFrontmatterSchema = z.object({
  name:        z.string().min(1),
  version:     z.string().default('1.0.0'),
  description: z.string().default(''),
  activates:   z.array(SkillActivateMode).default(['agent']),
  // B: temporary tool permission rules injected for the turn
  // These are tool name globs — same syntax as PermissionRule.tool
  'allowed-tools': z.array(z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ── Parsed skill manifest ────────────────────────────────────────────────────

export interface SkillManifest {
  /** Unique skill name from frontmatter. */
  name:         string;
  version:      string;
  description:  string;
  /** Which turn modes this skill activates in. */
  activates:    SkillActivateMode[];
  /** Tool name globs temporarily allowed while this skill is active. */
  allowedTools: string[];
  /** The markdown body (system prompt content to inject). */
  body:         string;
}

// ── Domain record (DB row + parsed manifest) ─────────────────────────────────

export interface SkillRecord {
  id:          string;
  manifest:    SkillManifest;
  sourceUrl?:  string;
  enabled:     boolean;
  installedAt: number;
  /** Raw SKILL.md for display / re-parsing. */
  rawMd:       string;
}
