import { describe, expect, it } from 'vitest';
import { SettingsStore, type SettingsRepository } from '@ema-agent/settings';
import { loadPermissionRules, reconcileProjectRules } from '../rules/loader.js';
import {
  permissionRulesProjectAllowSetting,
  permissionRulesProjectAskSetting,
  permissionRulesProjectDenySetting,
  permissionRulesUserAllowSetting,
} from '../settings.js';

function makeStore(): { store: SettingsStore; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const repository: SettingsRepository = {
    read: (key: string) =>
      (data.has(key)
        ? { status: 'found', value: data.get(key) }
        : { status: 'missing' }) as ReturnType<SettingsRepository['read']>,
    set: (key: string, value: unknown) => { data.set(key, value); },
    setMany: (entries) => { for (const entry of entries) data.set(entry.key, entry.value); },
    delete: (key: string) => { data.delete(key); },
  };
  return { store: new SettingsStore(repository), data };
}


describe('权限规则读取', () => {
  it('读取用户和当前项目设置, 新增设置在下一次读取生效', () => {
    const { store } = makeStore();
    store.set(permissionRulesUserAllowSetting, ['Read']);
    store.set(permissionRulesProjectAllowSetting, { a: ['Bash(pnpm test)'], b: ['Other'] });
    const rules = loadPermissionRules(store, 'a');
    expect(rules).toEqual([
      { key: { toolName: 'Bash', condition: 'pnpm test' }, decision: 'allow', from: 'projectSettings' },
      { key: { toolName: 'Read' }, decision: 'allow', from: 'userSettings' },
    ]);
    store.set(permissionRulesUserAllowSetting, ['Write']);
    expect(rules[1]!.key.toolName).toBe('Read');
    expect(loadPermissionRules(store)[0]!.key.toolName).toBe('Write');
  });

  it('只清理已删除项目的设置, 重复清理不改变保留的配置', () => {
    const { store } = makeStore();
    store.set(permissionRulesProjectAllowSetting, { alive: ['Read'], dead: ['Write'] });
    store.set(permissionRulesProjectAskSetting, { dead: ['Bash'] });
    store.set(permissionRulesProjectDenySetting, { dead: ['WebFetch'] });
    reconcileProjectRules(store, ['alive']);
    reconcileProjectRules(store, ['alive']);
    expect(store.get(permissionRulesProjectAllowSetting)).toEqual({ alive: ['Read'] });
    expect(store.get(permissionRulesProjectAskSetting)).toEqual({});
    expect(store.get(permissionRulesProjectDenySetting)).toEqual({});
  });
});
