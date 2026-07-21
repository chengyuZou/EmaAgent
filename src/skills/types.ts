// 这里定义 Skill manifest, 索引记录, 文件根目录和 Marketplace 业务类型.
import { z } from 'zod';
import type { SkillRow } from '@ema-agent/storage';

export interface SkillIndexRepository {
  upsertByName(row: SkillRow): void;
  replaceByName(oldName: string, row: SkillRow): void;
  setEnabled(name: string, enabled: number): void;
  setDirPath(name: string, dirPath: string): void;
  findByName(name: string): SkillRow | null;
  listAll(): SkillRow[];
  listEnabled(): SkillRow[];
  deleteByName(name: string): void;
}

// ── 来源 ─────────────────────────────────────────────────────────────────────

export type SkillSource = 'builtin' | 'user' | 'market';

// ── Frontmatter schema ───────────────────────────────────────────────────────
//
// skill 不按 turn 模式门禁 - skill 只分启用/禁用,模型从 `description` 决定相关性。
// (catalog 只在 skill_call 可调用处注入,即 agent 模式;这是机制决定,
// 不是 per-skill 标签。)

export const SkillNameSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .refine(name => !/[\\/\u0000-\u001f]/u.test(name), 'Skill name contains path separators or control characters')
  .refine(name => /[\p{L}\p{N}]/u.test(name), 'Skill name must contain at least one letter or number');

export const SkillFrontmatterSchema = z.object({
  name:        SkillNameSchema,
  version:     z.string().default('1.0.0'),
  description: z.string().default(''),
  // 在 catalog 中展示,让模型知道 `arguments` 传什么。
  'argument-hint': z.string().optional(),
  // 此 skill 激活时用于收窄 Agent 能力的工具名称或稳定工具 ID glob。
  'allowed-tools': z.array(z.string().trim().min(1).max(256)).max(64).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// ── 解析后的 skill manifest(完整 - 含 body,从磁盘读)─────────────────────

export interface SkillManifest {
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  /** 此 skill 激活时用于收窄 Agent 能力的工具名称或稳定工具 ID glob。 */
  allowedTools: string[];
  /** markdown body(system prompt 内容)- 事实来源是文件。 */
  body:         string;
}

/** Skill Facade 从磁盘校验并渲染后的结构化激活结果。 */
export interface ActivatedSkill {
  name:         string;
  content:      string;
  allowedTools: readonly string[];
}

// ── 索引记录(磁盘上一个 SKILL.md 的 SQL 索引一行)──────────────────────────

export interface SkillRecord {
  id:           string;
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  /** skill 目录的绝对路径(含 SKILL.md + assets)。 */
  dirPath:      string;
  source:       SkillSource;
  sourceUrl?:   string;
  /** skill 目录总字节(SKILL.md + assets)。 */
  sizeBytes:    number;
  enabled:      boolean;
  installedAt:  number;
}

// ── 轻量 catalog 摘要(注入 prompt 作"可用 skill")────────────────────────

export interface SkillSummary {
  name:          string;
  description:   string;
  argumentHint?: string;
}

// ── Skill root(扫描 `<slug>/SKILL.md` 的目录)──────────────────────────────

export interface SkillRoot {
  path:   string;
  source: SkillSource;
  /** builtin root 只读(不可 install / rename / delete)。 */
  readonly?: boolean;
}

// ── Marketplace ────────────────────────────────────────────────────────────────

/**
 * GitHub 仓库坐标 -- github 源的 market entry 携带,bundle 安装直接用,
 * 不靠 URL 反解析(避免 jsDelivr URL 解析失败丢 sibling assets)。
 * mirrorUrl 已知时 bundle 下载主走 mirror(CN 可达),降级 raw。
 */
export interface GithubSkillCoords {
  owner:     string;
  repo:      string;
  ref:       string;
  /** SKILL.md 所在目录(repo 内相对路径,空串表示根目录) */
  dir:       string;
  /** jsDelivr 等 CDN base,如 https://cdn.jsdelivr.net/gh/owner/repo@ref/ -- CN 可达 */
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
  /** 源仓库中出现的文件夹名 / skill slug。 */
  name:        string;
  /** 仓库内路径,如 "document-skills/pdf"。 */
  path:        string;
  /** SKILL.md 的原始 URL,可直接给 installFromUrl()。 */
  url:         string;
  /** GitHub 源携带坐标,bundle 安装优先用(不丢 mirrorUrl / 不靠 URL 反解析)。 */
  coords?:     GithubSkillCoords;
}
