// PermissionUpdate 应用：session → 内存 per-session 表（本 Turn 即效）；
// userSettings/projectSettings → settings KV（次 Turn 生效）。
import type { SettingsStore } from '@ema-agent/settings';
import type {
  PermissionBehavior,
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../types.js';
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js';
import {
  permissionModeSetting,
  permissionRulesProjectAllowSetting,
  permissionRulesProjectAskSetting,
  permissionRulesProjectDenySetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserAskSetting,
  permissionRulesUserDenySetting,
} from '../settings.js';

// ── session 内存表（本 Turn 即效；进程退出即消失 ───────────

const sessionAllowRules = new Map<string, string[]>();

export function getSessionAllowRules(sessionId: string): readonly string[] {
  return sessionAllowRules.get(sessionId) ?? [];
}

export function clearSessionRules(sessionId: string): void {
  sessionAllowRules.delete(sessionId);
}

// ── PermissionUpdate 应用 ──────────────────────────────────────────────────────

export function applyPermissionUpdate(
  store: SettingsStore,
  update: PermissionUpdate,
  context: { readonly sessionId: string; readonly projectId?: string },
): void {
  switch (update.type) {
    case 'addRules': {
      const ruleStrings = update.rules.map(permissionRuleValueToString);
      if (update.destination === 'session') {
        // "本 Session 允许"是 session 规则唯一语义；deny/ask 请写设置。
        if (update.behavior !== 'allow') {
          throw new Error('session destination 只支持 allow 行为');
        }
        const existing = sessionAllowRules.get(context.sessionId) ?? [];
        sessionAllowRules.set(
          context.sessionId,
          [...new Set([...existing, ...ruleStrings])],
        );
        return;
      }
      writeRules(store, update.destination, update.behavior, ruleStrings, 'add', context.projectId);
      return;
    }
    case 'removeRules': {
      const ruleStrings = update.rules.map(permissionRuleValueToString);
      if (update.destination === 'session') {
        const existing = sessionAllowRules.get(context.sessionId) ?? [];
        const remove = new Set(ruleStrings);
        const next = existing.filter((rule) => !remove.has(rule));
        if (next.length === 0) sessionAllowRules.delete(context.sessionId);
        else sessionAllowRules.set(context.sessionId, next);
        return;
      }
      writeRules(store, update.destination, update.behavior, ruleStrings, 'remove', context.projectId);
      return;
    }
    case 'setMode': {
      store.set(permissionModeSetting, update.mode);
      return;
    }
  }
}

/** 项目删除时清理三张 record 里该项目的条目；不存在则不动。 */
export function purgeProjectRules(store: SettingsStore, projectId: string): void {
  for (const setting of [
    permissionRulesProjectAllowSetting,
    permissionRulesProjectDenySetting,
    permissionRulesProjectAskSetting,
  ]) {
    const record = store.get(setting);
    if (!(projectId in record)) continue;
    const next = { ...record };
    delete next[projectId];
    store.set(setting, next);
  }
}

// ── settings 读写（destination + behavior 选 key） ─────────────────────────────

function writeRules(
  store: SettingsStore,
  destination: Exclude<PermissionUpdateDestination, 'session'>,
  behavior: PermissionBehavior,
  ruleStrings: readonly string[],
  operation: 'add' | 'remove',
  projectId?: string,
): void {
  if (destination === 'projectSettings' && !projectId) {
    throw new Error('写项目规则必须带 projectId');
  }
  if (destination === 'userSettings') {
    const setting = userSettingFor(behavior);
    const current = store.get(setting);
    store.set(setting, merge(current, ruleStrings, operation));
    return;
  }
  const setting = projectSettingFor(behavior);
  const record = store.get(setting);
  const current = record[projectId!] ?? [];
  const next = merge(current, ruleStrings, operation);
  const nextRecord = { ...record };
  if (next.length === 0) delete nextRecord[projectId!];
  else nextRecord[projectId!] = next;
  store.set(setting, nextRecord);
}

/**
 * roundtrip 规范化：parse→serialize 归一到规范形。
 * 'Bash()' / 'Bash(*)' → 'Bash'；'Bash(npm test)' 不变。
 * Claude 同款：add/delete 都按规范形去重和比较，等价写法不会并存、删除不失配。
 */
function normalizeRuleString(raw: string): string {
  return permissionRuleValueToString(permissionRuleValueFromString(raw));
}

function merge(
  current: readonly string[],
  ruleStrings: readonly string[],
  operation: 'add' | 'remove',
): string[] {
  if (operation === 'add') {
    // 统一存规范形，等价写法（Bash / Bash() / Bash(*)）只保留一条。
    return [...new Set([...current, ...ruleStrings].map(normalizeRuleString))];
  }
  const remove = new Set(ruleStrings.map(normalizeRuleString));
  // 按规范形比较：remove 'Bash' 能删掉存储里手写的 'Bash()'。
  return current.filter((rule) => !remove.has(normalizeRuleString(rule)));
}

function userSettingFor(behavior: PermissionBehavior) {
  switch (behavior) {
    case 'allow': return permissionRulesUserAllowSetting;
    case 'deny': return permissionRulesUserDenySetting;
    case 'ask': return permissionRulesUserAskSetting;
  }
}

function projectSettingFor(behavior: PermissionBehavior) {
  switch (behavior) {
    case 'allow': return permissionRulesProjectAllowSetting;
    case 'deny': return permissionRulesProjectDenySetting;
    case 'ask': return permissionRulesProjectAskSetting;
  }
}
