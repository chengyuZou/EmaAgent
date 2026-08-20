// Skill 领域语言:作用域、稳定身份、描述符、溯源,以及根 Turn 冻结的 SkillPool 形状。
// 冻结规则见 EmaSkillArchitecture.md v4;本文件不含激活态、Marketplace 等已删除概念。
import { z } from 'zod';

// ── 安全硬上限(原 limits.ts 并入) ─────────────────────────────────────────────

/** 单个 SKILL.md 的体积上限(有界读取)。 */
export const MAX_SKILL_BYTES = 512 * 1024;
/** 技能目录总字节上限(有界复制)。 */
export const MAX_SKILL_BUNDLE_BYTES = 8 * 1024 * 1024;
/** 技能目录文件数上限。 */
export const MAX_SKILL_BUNDLE_FILES = 80;
/** Prompt 常驻目录的总预算(单遍截断,超出省略并计数提示)。 */
export const SKILL_LISTING_BUDGET_BYTES = 8 * 1024;
/** 目录中单条描述的字符上限。 */
export const SKILL_LISTING_ENTRY_MAX_CHARS = 250;

// ── 作用域与稳定身份 ───────────────────────────────────────────────────────────

export type SkillScope = 'builtin' | 'user' | 'project';

/**
 * 跨进程稳定身份:
 *   builtin:<slug>                              随应用发布
 *   user:<pathHash>                             手动放置(改名=新技能)
 *   user:site_<siteId>_<entryId>                站点安装
 *   project:<sourceId>:<workspaceRelPath>       工作区生态原位
 */
export type SkillKey = `${SkillScope}:${string}`;

/** SkillKey 格式校验（settings schema 与 wire 边界共用同一事实源）。 */
export const SKILL_KEY_PATTERN = /^(builtin|user|project):.+$/;

/** wire/输入边界的 SkillKey 窄化；不合法返回 null。 */
export function parseSkillKey(raw: string): SkillKey | null {
  return SKILL_KEY_PATTERN.test(raw) ? (raw as SkillKey) : null;
}

// ── 描述符(注册表与 Pool 的统一条目) ─────────────────────────────────────────

export interface SkillDescriptor {
  key: SkillKey;
  /** 展示名。 */
  name: string;
  /** 模型可调用名;冲突时按确定性规则生成别名。 */
  callName: string;
  version: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  /** 只收窄,绝不授权。 */
  allowedToolPatterns: string[];
  rootPath: string;
  scope: SkillScope;
  provenance?: SkillInstallProvenance;
}

export type SkillInstallProvenance =
  | { kind: 'localDirectory' }
  | {
      kind: 'site';
      siteId: string;
      siteEntryId: string;
      /** 站点索引版本,更新对账的唯一事实源(frontmatter version 只展示)。 */
      version: string;
      bundleUrl: string;
      bundleSha256: string;
    };

/** 根 Turn 冻结的技能快照(镜像 ToolPool);不承载激活状态。 */
export interface SkillPool {
  /** 有序 entries 的稳定哈希,进 Prompt Cache 诊断。 */
  readonly revision: string;
  /** 按 (scopeRank, callName) 排序。 */
  readonly entries: readonly SkillDescriptor[];
  getByKey(key: SkillKey): SkillDescriptor | undefined;
  getByCallName(name: string): SkillDescriptor | undefined;
}

// ── SKILL.md frontmatter ──────────────────────────────────────────────────────

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
  /** 在目录中展示,让模型知道 arguments 传什么。 */
  'argument-hint': z.string().optional(),
  /** 激活时收窄 Agent 能力的工具名称或稳定工具 ID glob;只收窄不授权。 */
  'allowed-tools': z.array(z.string().trim().min(1).max(256)).max(64).optional(),
  /** 模型决定相关性的关键文案。 */
  'when-to-use': z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** 解析后的 SKILL.md 全文(含 body)。body 是不可信运行时上下文,不是 System Prompt。 */
export interface SkillManifest {
  name:         string;
  version:      string;
  description:  string;
  argumentHint?: string;
  whenToUse?:   string;
  allowedTools: string[];
  body:         string;
}
