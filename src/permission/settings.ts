// Permission 的用户设置：三档规则（全局/按项目）+ 执行模式 + 批准等待超时。
// session 源规则是纯内存（rules/update.ts），不是设置。
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

export const permissionModeSetting = defineSetting({
  key: 'permission.mode',
  description: '工具执行的权限模式：default=按规则或询问；acceptEdits=额外允许工作区文件写入；bypassPermissions=仅开发入口可开启。',
  apply: 'nextTurn',
  defaultValue: 'default' as const,
  schema: z.enum(['default', 'acceptEdits', 'bypassPermissions'])
    .describe('工具执行的权限模式：default=按规则或询问；acceptEdits=额外允许工作区文件写入；bypassPermissions=仅开发入口可开启。'),
});

export const DEFAULT_PERMISSION_ASK_TIMEOUT_MS: null = null;
export const MIN_PERMISSION_ASK_TIMEOUT_MS = 5_000;
export const MAX_PERMISSION_ASK_TIMEOUT_MS = 600_000;

const RULE_FORMAT_HINT = '格式："Tool" 或 "Tool(content)"，如 Bash(npm test:*)、Read(./src/**)';

export const permissionRulesUserAllowSetting = defineSetting({
  key: 'permission.rules.user.allow',
  description: '全局 allow 规则：命中即自动允许。格式："Tool" 或 "Tool(content)"，如 Bash(npm test:*)。',
  apply: 'nextTurn',
  defaultValue: [] as string[],
  schema: z.array(z.string())
    .describe(`全局 allow 规则：命中即自动允许。${RULE_FORMAT_HINT}`),
});

export const permissionRulesUserDenySetting = defineSetting({
  key: 'permission.rules.user.deny',
  description: '全局 deny 规则：命中即拒绝（优先级最高，bypass 也救不了）。格式："Tool" 或 "Tool(content)"。',
  apply: 'nextTurn',
  defaultValue: [] as string[],
  schema: z.array(z.string())
    .describe(`全局 deny 规则：命中即拒绝（优先级最高，bypass 也救不了）。${RULE_FORMAT_HINT}`),
});

export const permissionRulesUserAskSetting = defineSetting({
  key: 'permission.rules.user.ask',
  description: '全局 ask 规则：命中即弹批准卡（先于 bypass 生效）。格式："Tool" 或 "Tool(content)"。',
  apply: 'nextTurn',
  defaultValue: [] as string[],
  schema: z.array(z.string())
    .describe(`全局 ask 规则：命中即弹批准卡（先于 bypass 生效）。${RULE_FORMAT_HINT}`),
});

const projectRuleRecord = (behavior: string) =>
  z.record(z.string(), z.array(z.string()))
    .describe(`按项目的 ${behavior} 规则：键为项目 id，值为该项目的规则列表。${RULE_FORMAT_HINT}`);

export const permissionRulesProjectAllowSetting = defineSetting({
  key: 'permission.rules.project.allow',
  description: '按项目的 allow 规则：键为项目 id，值为该项目的规则列表（格式同全局规则）。',
  apply: 'nextTurn',
  defaultValue: {} as Record<string, string[]>,
  schema: projectRuleRecord('allow'),
});

export const permissionRulesProjectDenySetting = defineSetting({
  key: 'permission.rules.project.deny',
  description: '按项目的 deny 规则：键为项目 id，值为该项目的规则列表（格式同全局规则）。',
  apply: 'nextTurn',
  defaultValue: {} as Record<string, string[]>,
  schema: projectRuleRecord('deny'),
});

export const permissionRulesProjectAskSetting = defineSetting({
  key: 'permission.rules.project.ask',
  description: '按项目的 ask 规则：键为项目 id，值为该项目的规则列表（格式同全局规则）。',
  apply: 'nextTurn',
  defaultValue: {} as Record<string, string[]>,
  schema: projectRuleRecord('ask'),
});

export const permissionAskTimeoutSetting = defineSetting<number | null>({
  key: 'permission.askTimeoutMs',
  description: '批准卡与问询卡的等待超时（毫秒）；null = 一直等待。',
  apply: 'nextOperation',
  defaultValue: DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  schema: z.union([
    z.null(),
    z.number().int().min(MIN_PERMISSION_ASK_TIMEOUT_MS).max(MAX_PERMISSION_ASK_TIMEOUT_MS),
  ]).describe('批准卡与问询卡的等待超时（毫秒）；null = 一直等待。'),
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
