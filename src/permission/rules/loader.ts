import type { SettingsStore } from '@ema-agent/settings';
import type { PermissionRule } from '../types.js';
import { parsePermissionRuleKey } from './permissionRuleParser.js';
import {
  permissionRulesProjectAllowSetting,
  permissionRulesProjectAskSetting,
  permissionRulesProjectDenySetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserAskSetting,
  permissionRulesUserDenySetting,
} from '../settings.js';

// 用户和项目设置只读取一次, 供本次 Turn 使用. Session 批准不混进这个固定数组.
export function loadPermissionRules(store: SettingsStore, projectId?: string): PermissionRule[] {
  const rules: PermissionRule[] = [];
  const groups = [
    ['deny', permissionRulesUserDenySetting, permissionRulesProjectDenySetting],
    ['ask', permissionRulesUserAskSetting, permissionRulesProjectAskSetting],
    ['allow', permissionRulesUserAllowSetting, permissionRulesProjectAllowSetting],
  ] as const;
  for (const [decision, userSetting, projectSetting] of groups) {
    if (projectId) {
      for (const text of store.get(projectSetting)[projectId] ?? []) {
        rules.push({ key: parsePermissionRuleKey(text), decision, from: 'projectSettings' });
      }
    }
    for (const text of store.get(userSetting)) {
      rules.push({ key: parsePermissionRuleKey(text), decision, from: 'userSettings' });
    }
  }
  return rules;
}

// 项目删除中途退出后, 启动时清理已不存在项目的规则.
export function reconcileProjectRules(store: SettingsStore, existingProjectIds: readonly string[]): void {
  const existing = new Set(existingProjectIds);
  for (const setting of [
    permissionRulesProjectAllowSetting,
    permissionRulesProjectAskSetting,
    permissionRulesProjectDenySetting,
  ]) {
    const record = store.get(setting);
    const orphans = Object.keys(record).filter(id => !existing.has(id));
    if (orphans.length === 0) continue;
    const next = { ...record };
    for (const id of orphans) delete next[id];
    store.set(setting, next);
  }
}
