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

/**
 * GitHub 仓库坐标 —— github 源的 market entry 携带,bundle 安装直接用,
 * 不靠 URL 反解析(避免 jsDelivr URL 解析失败丢 sibling assets)。
 * mirrorUrl 已知时 bundle 下载主走 mirror(CN 可达),降级 raw。
 */
export interface GithubSkillCoords {
  owner:     string;
  repo:      string;
  ref:       string;
  /** SKILL.md 所在目录(repo 内相对路径,空串表示根目录) */
  dir:       string;
  /** jsDelivr 等 CDN base,如 https://cdn.jsdelivr.net/gh/owner/repo@ref/ —— CN 可达 */
  mirrorUrl?: string;
}

/** Zod schema for GithubSkillCoords(路由层校验 market install 透传的坐标)。 */
export const GithubSkillCoordsSchema = z.object({
  owner:     z.string().min(1),
  repo:      z.string().min(1),
  ref:       z.string().min(1),
  dir:       z.string().default(''),
  mirrorUrl: z.string().url().optional(),
});

export interface MarketSkillEntry {
  /** Folder name / skill slug as it appears in the source repo. */
  name:        string;
  /** Path within the repo, e.g. "document-skills/pdf". */
  path:        string;
  /** Raw URL to the SKILL.md, ready for installFromUrl(). */
  url:         string;
  /** GitHub 源携带坐标,bundle 安装优先用(不丢 mirrorUrl / 不靠 URL 反解析)。 */
  coords?:     GithubSkillCoords;
}
