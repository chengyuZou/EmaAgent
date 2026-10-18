import { z } from 'zod';

/** Prompt 技能条目的 UTF-8 总预算, 条目间换行和省略提示额外计算. */
export const SKILL_LISTING_BUDGET_BYTES = 8 * 1024;
/** 目录中单条描述的字符上限. */
export const SKILL_LISTING_ENTRY_MAX_CHARS = 250;
/** 详情文件清单的条目上限(防失控目录撑爆响应). */
export const SKILL_FILES_MAX = 200;
/** 详情文件预览的体积上限(超出截断并标记). */
export const SKILL_FILE_PREVIEW_MAX_BYTES = 300 * 1024;

/**
 * builtin 来自 profile 内的应用技能副本, user 来自用户目录,
 * project 从当前项目文件夹中扫描. user 目录也接受手动放入的技能.
 */
export type SkillScope = 'builtin' | 'user' | 'project';

export interface SkillDescriptor {
  name: string;
  /** SKILL.md 的绝对路径,同时是技能身份. */
  path: string;
  version?: string;
  description: string;
  whenToUse?: string;
  scope: SkillScope;
  /** project 技能所属生态,供来源级启停使用. */
  projectSourceId?: string;
  /** project 技能所在的项目源文件夹,供菜单显示真实出处. */
  sourceFolderPath?: string;
  /** builtin/user 扫描时测量的目录字节数, 用于列表展示. */
  sizeBytes?: number;
}

/** Turn 开始时选定的技能目录. 正文不在池中, 调用 Skill 工具时从文件读取. */
export interface SkillPool {
  /** 按 (scopeRank, name, path) 排序. */
  readonly entries: readonly SkillDescriptor[];
  getByPath(path: string): SkillDescriptor | undefined;
}

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
  /** 模型决定相关性的关键文案. */
  'when-to-use': z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** 从 SKILL.md frontmatter 解析出的目录字段. */
export interface ParsedSkillMd {
  name:          string;
  version?:      string;
  description:   string;
  whenToUse?:    string;
}
