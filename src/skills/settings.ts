// Skill 域的用户设置:逐技能禁用与两个来源级开关,统一 deny 语义。
// 一字段一 key;过滤/去重/上限由 zod 的 regex/max/transform 承担。
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';
import { SKILL_KEY_PATTERN } from './types.js';

const SOURCE_ID = /^[a-z][a-z0-9-]*$/;

/** 唯一逐技能禁用:SkillKey deny-list,builtin/user/project 三作用域统一。 */
export const disabledSkillKeysSetting = defineSetting<string[]>({
  key: 'skill.disabledKeys',
  label: '逐技能禁用列表',
  description: '逐技能禁用：SkillKey deny-list，builtin/user/project 三作用域统一。',
  apply: 'nextTurn',
  defaultValue: [],
  schema: z
    .array(z.string().regex(SKILL_KEY_PATTERN))
    .max(500)
    .transform(keys => [...new Set(keys)]),
});

/** project 生态来源级禁用:空数组 = 全部启用;新出现的生态来源默认启用。 */
export const disabledProjectSourcesSetting = defineSetting<{ disabledSourceIds: string[] }>({
  key: 'skill.disabledProjectSources',
  label: '项目技能来源禁用',
  description: 'project 生态来源级禁用：空数组 = 全部启用；新出现的生态来源默认启用。',
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

/** 内置来源总开关(Codex bundled.enabled 同款),默认开。 */
export const builtinSkillsEnabledSetting = defineSetting<boolean>({
  key: 'skill.builtinEnabled',
  label: '内置技能总开关',
  description: '内置来源总开关（Codex bundled.enabled 同款），默认开。',
  apply: 'nextTurn',
  defaultValue: true,
  schema: z.boolean(),
});
