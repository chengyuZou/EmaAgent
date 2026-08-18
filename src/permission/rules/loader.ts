// 从 settings 读出规则并按 source 装配判定桶；开机对账项目规则（崩溃收敛）。
import type { SettingsStore } from '@ema-agent/settings';
import type { ToolPermissionRulesBySource } from '../types.js';
import {
  permissionRulesProjectAllowSetting,
  permissionRulesProjectAskSetting,
  permissionRulesProjectDenySetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserAskSetting,
  permissionRulesUserDenySetting,
} from '../settings.js';
import { getSessionAllowRules } from './update.js';

/** hasPermissionsToUseTool 的三桶规则（原始字符串，解析推迟到 Tool match 时）。 */
export interface PermissionRuleBuckets {
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  readonly alwaysAskRules: ToolPermissionRulesBySource;
}

/**
 * Turn 准备时调用：settings 源规则冻结装配（user + 当前项目）；
 * session 源（本 Turn 即效）并入 allow 桶。
 */
export function loadPermissionRuleBuckets(
  store: SettingsStore,
  sessionId: string,
  projectId?: string,
): PermissionRuleBuckets {
  const sessionAllow = getSessionAllowRules(sessionId);
  // 与 session 桶一致：无规则时省略键，不出现空数组（空数组 truthy 会误带键）。
  const project = <T extends Record<string, string[]>>(record: T, projectId?: string) =>
    projectId && (record[projectId]?.length ?? 0) > 0 ? record[projectId] : undefined;

  const projectAllow = project(store.get(permissionRulesProjectAllowSetting), projectId);
  const projectDeny = project(store.get(permissionRulesProjectDenySetting), projectId);
  const projectAsk = project(store.get(permissionRulesProjectAskSetting), projectId);

  return {
    alwaysAllowRules: {
      userSettings: store.get(permissionRulesUserAllowSetting),
      ...(projectAllow ? { projectSettings: projectAllow } : {}),
      ...(sessionAllow.length > 0 ? { session: sessionAllow } : {}),
    },
    alwaysDenyRules: {
      userSettings: store.get(permissionRulesUserDenySetting),
      ...(projectDeny ? { projectSettings: projectDeny } : {}),
    },
    alwaysAskRules: {
      userSettings: store.get(permissionRulesUserAskSetting),
      ...(projectAsk ? { projectSettings: projectAsk } : {}),
    },
  };
}

/**
 * 开机对账：三张 record 的键 ∩ 现存项目 id 过滤，有差集才写回（幂等）。
 * 兜"删除项目后停电没来得及清"的底；调用方（装配层）从 session 公开入口取项目列表传入。
 */
export function reconcileProjectRules(
  store: SettingsStore,
  existingProjectIds: readonly string[],
): void {
  const existing = new Set(existingProjectIds);
  for (const setting of [
    permissionRulesProjectAllowSetting,
    permissionRulesProjectDenySetting,
    permissionRulesProjectAskSetting,
  ]) {
    const record = store.get(setting);
    const orphans = Object.keys(record).filter((id) => !existing.has(id));
    if (orphans.length === 0) continue;
    const next = { ...record };
    for (const id of orphans) delete next[id];
    store.set(setting, next);
  }
}
