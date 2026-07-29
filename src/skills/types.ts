// 定义 Skill manifest、文件快照、运行态激活结果和 Marketplace 业务类型。
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
  /** SKILL.md 正文；属于不可信的运行时上下文，不是 System Prompt。 */
  body:         string;
}

export type SkillFileKind =
  | 'instructions'
  | 'script'
  | 'reference'
  | 'template'
  | 'asset'
  | 'resource';

/** Skill Bundle 中一个真实文件的不可变索引，不把文件正文常驻内存。 */
export interface SkillFile {
  /** 文件的绝对路径。 */
  path: string;
  /** 相对 Skill 根目录的稳定 POSIX 路径。 */
  relativePath: string;
  kind: SkillFileKind;
  sizeBytes: number;
  sha256: string;
}

/** Skill 从磁盘校验、参数渲染并冻结后的结构化激活快照。 */
export interface ActivatedSkill {
  skillId: string;
  name: string;
  version: string;
  source: SkillSource;
  /** 当前 Skill 的 SKILL.md 绝对路径。 */
  path: string;
  /** SKILL.md 与同目录资源共同组成的 Bundle 根目录。 */
  rootPath: string;
  /** 对全部 Bundle 文件路径和内容摘要计算的稳定 revision。 */
  bundleRevision: string;
  arguments?: string;
  instructions: string;
  allowedToolPatterns: readonly string[];
  files: readonly SkillFile[];
}

/** 外部执行层调用 Skill 激活能力时使用的稳定入口。 */
export interface SkillRunnerPort {
  run(
    skill: string,
    args: string | undefined,
  ): Promise<ActivatedSkill>;
}

/** 每个 Agent 独立持有的 Skill 激活状态，不能跨 Agent 共享可变 Map。 */
export interface ActiveSkillStatePort {
  activate(skill: ActivatedSkill): void;
  list(): readonly ActivatedSkill[];
}

// ── 索引记录(磁盘上一个 SKILL.md 的 SQL 索引一行)──────────────────────────

export interface SkillRecord {
  id:           string;
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  /** SKILL.md 的绝对路径。 */
  path:         string;
  /** Skill 目录的绝对路径（含 SKILL.md 与资源文件）。 */
  dirPath:      string;
  source:       SkillSource;
  sourceUrl?:   string;
  /** skill 目录总字节(SKILL.md + assets)。 */
  sizeBytes:    number;
  enabled:      boolean;
  installedAt:  number;
}

// ── 轻量 catalog 摘要（注入 Context 作为“可用 Skill”）────────────────────

export interface SkillSummary {
  skillId:       string;
  name:          string;
  version:       string;
  description:   string;
  argumentHint?: string;
  /** 对应 SKILL.md 的绝对路径；Catalog 渲染不会把本机路径发给模型。 */
  path:          string;
  source:        SkillSource;
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
  /** SKILL.md 的原始 URL，可直接给 installFromUrl()。 */
  url:         string;
  /** 对 SKILL.md 与全部 Bundle 资源计算的规范 SHA-256 revision。 */
  sha256?:     string;
  /** GitHub 源携带坐标,bundle 安装优先用(不丢 mirrorUrl / 不靠 URL 反解析)。 */
  coords?:     GithubSkillCoords;
}
