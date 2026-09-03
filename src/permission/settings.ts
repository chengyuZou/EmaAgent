// Permission 的用户设置：三档规则（全局/按项目）+ 执行模式 + 批准等待超时。
// session 源规则是纯内存（rules/update.ts），不是设置。
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const permissionModeSetting = defineSetting({
  key: 'permission.mode',
  apply: 'nextTurn',
  defaultValue: 'default' as const,
  schema: z.enum(['default', 'acceptEdits', 'bypassPermissions']),
});

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

/** permission 包全部设置定义（供 SettingsStore 注册）。 */
export const PERMISSION_SETTINGS = [
  permissionModeSetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserDenySetting,
  permissionRulesUserAskSetting,
  permissionRulesProjectAllowSetting,
  permissionRulesProjectDenySetting,
  permissionRulesProjectAskSetting,
  permissionAskTimeoutSetting,
] as const;
