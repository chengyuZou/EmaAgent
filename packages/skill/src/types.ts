import { z } from 'zod';

// ── Source ─────────────────────────────────────────────────────────────────────

export type SkillSource = 'builtin' | 'user' | 'market';

// ── Frontmatter schema ───────────────────────────────────────────────────────
//
// Skills are NOT gated by turn mode — a skill is simply enabled or disabled, and
// the model decides relevance from `description`. (The catalog is only injected
// where skill_call is invocable, i.e. agent mode; that is a mechanism decision,
// not a per-skill tag.)

export const SkillFrontmatterSchema = z.object({
  name:        z.string().min(1),
  version:     z.string().default('1.0.0'),
  description: z.string().default(''),
  // Shown in the catalog so the model knows what to pass as `arguments`.
  'argument-hint': z.string().optional(),
  // Tool-name globs temporarily allowed while this skill is active (enforced at
  // activation via a turn-scoped permission grant).
  'allowed-tools': z.array(z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ── Parsed skill manifest (full — includes body, read from disk) ──────────────

export interface SkillManifest {
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  /** Tool name globs temporarily allowed while this skill is active. */
  allowedTools: string[];
  /** The markdown body (system prompt content) — source of truth is the file. */
  body:         string;
}

// ── Index record (one row of the SQL index over a SKILL.md on disk) ───────────

export interface SkillRecord {
  id:           string;
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  /** Absolute path to the skill directory (contains SKILL.md + assets). */
  dirPath:      string;
  source:       SkillSource;
  sourceUrl?:   string;
  /** Total size of the skill directory in bytes (SKILL.md + assets). */
  sizeBytes:    number;
  enabled:      boolean;
  installedAt:  number;
}

// ── Lightweight catalog summary (injected into the prompt as "available skills") ─

export interface SkillSummary {
  name:          string;
  description:   string;
  argumentHint?: string;
}

// ── Skill root (a directory scanned for `<slug>/SKILL.md`) ─────────────────────

export interface SkillRoot {
  path:   string;
  source: SkillSource;
  /** builtin roots are read-only (no install / rename / delete). */
  readonly?: boolean;
}

// ── Marketplace ────────────────────────────────────────────────────────────────

export interface MarketSkillEntry {
  /** Folder name / skill slug as it appears in the source repo. */
  name:        string;
  /** Path within the repo, e.g. "document-skills/pdf". */
  path:        string;
  /** Raw URL to the SKILL.md, ready for installFromUrl(). */
  skillMdUrl:  string;
}
