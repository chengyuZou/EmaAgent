import { z } from 'zod';

// ── Prompt 目录预算 ───────────────────────────────────────────────────────────

/** Prompt 常驻目录的总预算(单遍截断,超出省略并计数提示)。 */
export const SKILL_LISTING_BUDGET_BYTES = 8 * 1024;
/** 目录中单条描述的字符上限。 */
export const SKILL_LISTING_ENTRY_MAX_CHARS = 250;
/** 详情文件清单的条目上限(防失控目录撑爆响应)。 */
export const SKILL_FILES_MAX = 200;
/** 详情文件预览的体积上限(超出截断并标记)。 */
export const SKILL_FILE_PREVIEW_MAX_BYTES = 300 * 1024;

/**
 * 技能作用域:
 *   builtin: 随应用发布的技能,不随用户/工作区变动。
 *   user:    通过市场下载的技能
 *   project: 工作区生态原位的技能,随工作区变动。
 */
export type SkillScope = 'builtin' | 'user' | 'project';

// ── 描述符(注册表与 Pool 的统一条目) ─────────────────────────────────────────

export interface SkillDescriptor {
  /** 展示名。 */
  name: string;
  /** SKILL.md 的绝对路径,同时是技能身份。 */
  path: string;
  version?: string;
  description: string;
  whenToUse?: string;
  scope: SkillScope;
  /** project 技能所属生态,供来源级启停使用。 */
  projectSourceId?: string;
  /** project 技能所在的项目源文件夹,供菜单显示真实出处。 */
  sourceFolderPath?: string;
  /** 目录总字节(user 域对账时测量);展示用,不进 Prompt。 */
  sizeBytes?: number;
}

/** 根 Turn 冻结的技能快照(镜像 ToolPool);不承载激活状态。 */
export interface SkillPool {
  /** 按 (scopeRank, name, path) 排序。 */
  readonly entries: readonly SkillDescriptor[];
  getByPath(path: string): SkillDescriptor | undefined;
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
  version:     z.string().optional(),
  description: z.string().default(''),
  /** 模型决定相关性的关键文案。 */
  'when-to-use': z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** 从 SKILL.md frontmatter 解析出的目录字段。 */
export interface ParsedSkillMd {
  name:          string;
  version?:      string;
  description:   string;
  whenToUse?:    string;
}
