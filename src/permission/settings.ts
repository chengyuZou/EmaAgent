import { defineSetting } from '@ema-agent/settings/definition';
import { z } from 'zod';

/** null 表示不因等待时长自动拒绝, Turn/Run 取消或 Session 删除仍会结束等待. */
export const DEFAULT_PERMISSION_ASK_TIMEOUT_MS: null = null;
export const MIN_PERMISSION_ASK_TIMEOUT_MS = 200_000;
export const MAX_PERMISSION_ASK_TIMEOUT_MS = 600_000;

export const permissionRulesUserAllowSetting = defineSetting({
  key: 'permission.rules.user.allow',
  apply: 'nextTurn',
  defaultValue: [] as string[],
  schema: z.array(z.string()),
});

export const permissionRulesUserDenySetting = defineSetting({
  key: 'permission.rules.user.deny',
  apply: 'nextTurn',
  defaultValue: [] as string[],
  schema: z.array(z.string()),
});

export const permissionRulesUserAskSetting = defineSetting({
  key: 'permission.rules.user.ask',
  apply: 'nextTurn',
  defaultValue: [] as string[],
  schema: z.array(z.string()),
});

const projectRuleRecord = z.record(z.string(), z.array(z.string()));

export const permissionRulesProjectAllowSetting = defineSetting({
  key: 'permission.rules.project.allow',
  apply: 'nextTurn',
  defaultValue: {} as Record<string, string[]>,
  schema: projectRuleRecord,
});

export const permissionRulesProjectDenySetting = defineSetting({
  key: 'permission.rules.project.deny',
  apply: 'nextTurn',
  defaultValue: {} as Record<string, string[]>,
  schema: projectRuleRecord,
});

export const permissionRulesProjectAskSetting = defineSetting({
  key: 'permission.rules.project.ask',
  apply: 'nextTurn',
  defaultValue: {} as Record<string, string[]>,
  schema: projectRuleRecord,
});

export const permissionAskTimeoutSetting = defineSetting({
  key: 'permission.askTimeoutMs',
  apply: 'nextOperation',
  defaultValue: DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  schema: z.union([
    z.null(),
    z.number().int().min(MIN_PERMISSION_ASK_TIMEOUT_MS).max(MAX_PERMISSION_ASK_TIMEOUT_MS),
  ]),
});

export const PERMISSION_SETTINGS = [
  permissionRulesUserAllowSetting,
  permissionRulesUserDenySetting,
  permissionRulesUserAskSetting,
  permissionRulesProjectAllowSetting,
  permissionRulesProjectDenySetting,
  permissionRulesProjectAskSetting,
  permissionAskTimeoutSetting,
] as const;
