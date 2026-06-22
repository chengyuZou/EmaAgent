import { z } from 'zod';

// ── Activation modes ─────────────────────────────────────────────────────────

export const SkillActivateMode = z.enum(['chat', 'narrative', 'agent']);
export type SkillActivateMode = z.infer<typeof SkillActivateMode>;

export type SkillSource = 'builtin' | 'user' | 'market';

// ── Frontmatter schema ───────────────────────────────────────────────────────

export const SkillFrontmatterSchema = z.object({
  name:        z.string().min(1),
  version:     z.string().default('1.0.0'),
  description: z.string().default(''),
  activates:   z.array(SkillActivateMode).default(['agent']),
  // Shown in the catalog so the model knows what to pass as `arguments`.
  'argument-hint': z.string().optional(),
  // Temporary tool permission rules injected for the turn while this skill is
  // active. Tool-name globs — same syntax as PermissionRule.tool.
  'allowed-tools': z.array(z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ── Parsed skill manifest (full — includes body, read from disk) ──────────────

export interface SkillManifest {
  /** Unique skill name from frontmatter. */
  name:         string;
  version:      string;
  description:  string;
  /** UI/catalog hint for the `arguments` string. */
  argumentHint?: string;
  /** Which turn modes this skill activates in. */
  activates:    SkillActivateMode[];
  /** Tool name globs temporarily allowed while this skill is active. */
  allowedTools: string[];
  /** The markdown body (system prompt content) — source of truth is the file. */
  body:         string;
}

// ── Index record (one row of the SQL index over a SKILL.md on disk) ───────────
//
// Does NOT carry the body — the body is read lazily from `<dirPath>/SKILL.md`
// on activation (render). This is what list / findByName return.

export interface SkillRecord {
  id:           string;
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  activates:    SkillActivateMode[];
  /** Absolute path to the skill directory (contains SKILL.md + assets). */
  dirPath:      string;
  source:       SkillSource;
  sourceUrl?:   string;
  enabled:      boolean;
  installedAt:  number;
}

// ── Lightweight catalog summary (injected into the prompt as "available skills") ─

export interface SkillSummary {
  name:          string;
  description:   string;
  argumentHint?: string;
  activates:     SkillActivateMode[];
}

// ── Skill root (a directory scanned for `<slug>/SKILL.md`) ─────────────────────

export interface SkillRoot {
  path:   string;
  source: SkillSource;
  /** builtin roots are read-only (no install / rename / delete). */
  readonly?: boolean;
}
