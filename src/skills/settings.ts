// Skill 域的用户设置:project 生态来源开关与工作区指令文件。
// 逐技能启停不进 Settings——那是 skill_enablement 表的事(skills 业务拥有)。
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

const SOURCE_ID = /^[a-z][a-z0-9-]*$/;

/** 作为工作区指令注入 Context 的候选文件,顺序也是最终拼接顺序. */
export const WORKSPACE_INSTRUCTION_FILE_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** project 生态来源级禁用:空数组 = 全部启用;新出现的生态来源默认启用。 */
export const disabledProjectSourcesSetting = defineSetting({
  key: 'skill.disabledProjectSources',
  apply: 'nextTurn',
  defaultValue: { disabledSourceIds: [] },
  schema: z
    .object({
      disabledSourceIds: z
        .array(z.string().regex(SOURCE_ID))
        .max(64)
        .transform(ids => [...new Set(ids)]),
    }),
});

/** 与 Skills 一同进入 Context 的工作区指令文件,由参数设置页面提供多选. */
export const workspaceInstructionFilesSetting = defineSetting({
  key: 'workspace.instructionFiles',
  apply: 'nextTurn',
  defaultValue: ['CLAUDE.md', 'AGENTS.md'],
  schema: z.array(z.enum(WORKSPACE_INSTRUCTION_FILE_CANDIDATES)).max(20),
});
