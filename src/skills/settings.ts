// Skill 域的用户设置:逐技能禁用与两个来源级开关,统一 deny 语义(架构 v4 §3.1)。
import { defineSetting } from '@ema-agent/settings';

/** 唯一逐技能禁用:SkillKey deny-list,builtin/user/project 三作用域统一。 */
export const disabledSkillKeysSetting = defineSetting<string[]>({
  key: 'skill.disabledKeys',
  kind: 'object',
  apply: 'nextTurn',
  defaultValue: [],
  decode(value: unknown) {
    if (!Array.isArray(value)) return { ok: false };
    const keys = [...new Set(value
      .filter((k): k is string => typeof k === 'string' && /^(builtin|user|project):.+$/.test(k))
      .slice(0, 500))];
    return { ok: true, value: keys };
  },
});

/** project 生态来源级禁用:空数组 = 全部启用;新出现的生态来源默认启用。 */
export const disabledProjectSourcesSetting = defineSetting<{ disabledSourceIds: string[] }>({
  key: 'skill.disabledProjectSources',
  kind: 'object',
  apply: 'nextTurn',
  defaultValue: { disabledSourceIds: [] },
  decode(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value['disabledSourceIds'])) return { ok: false };
    const ids = [...new Set(value['disabledSourceIds']
      .filter((id): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id))
      .slice(0, 64))];
    return { ok: true, value: { disabledSourceIds: ids } };
  },
});

/** 内置来源总开关(Codex bundled.enabled 同款),默认开。 */
export const builtinSkillsEnabledSetting = defineSetting<boolean>({
  key: 'skill.builtinEnabled',
  kind: 'boolean',
  apply: 'nextTurn',
  defaultValue: true,
  decode: (value: unknown) => typeof value === 'boolean' ? { ok: true, value } : { ok: false },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
