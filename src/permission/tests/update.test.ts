// 测试 PermissionUpdate 应用：session 内存表、settings KV 读写、项目清理与 mode 写入。
import { describe, expect, it } from 'vitest';
import { SettingsStore, type SettingsRepository } from '@ema-agent/settings';
import {
  applyPermissionUpdate,
  clearSessionRules,
  getSessionAllowRules,
  purgeProjectRules,
} from '../rules/update.js';
import {
  permissionModeSetting,
  permissionRulesProjectAllowSetting,
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

describe('applyPermissionUpdate', () => {
  it('session addRules 进内存表（即效、去重、可清空）', () => {
    const { store } = makeStore();
    const context = { sessionId: 's1' };
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'session', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Bash', ruleContent: 'npm test' }],
    }, context);

    expect(getSessionAllowRules('s1')).toEqual(['Bash(npm test)']);
    expect(store.get(permissionRulesUserAllowSetting)).toEqual([]);

    clearSessionRules('s1');
    expect(getSessionAllowRules('s1')).toEqual([]);
  });

  it('session 只支持 allow 行为，deny 直接拒绝', () => {
    const { store } = makeStore();
    expect(() => applyPermissionUpdate(store, {
      type: 'addRules', destination: 'session', behavior: 'deny',
      rules: [{ toolName: 'Bash' }],
    }, { sessionId: 's1' })).toThrow(/allow/);
  });

  it('userSettings addRules 写 KV 并去重；removeRules 规范化移除', () => {
    const { store } = makeStore();
    const context = { sessionId: 's1' };
    const update = {
      type: 'addRules' as const, destination: 'userSettings' as const, behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Read' }],
    };
    applyPermissionUpdate(store, update, context);
    applyPermissionUpdate(store, update, context);

    expect(store.get(permissionRulesUserAllowSetting)).toEqual(['Bash(npm test)', 'Read']);

    applyPermissionUpdate(store, {
      type: 'removeRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Read' }],
    }, context);
    expect(store.get(permissionRulesUserAllowSetting)).toEqual(['Bash(npm test)']);
  });

  it('projectSettings 按 projectId 分桶写；缺 projectId 拒绝；purgeProjectRules 清三张 record', () => {
    const { store } = makeStore();
    expect(() => applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash' }],
    }, { sessionId: 's1' })).toThrow(/projectId/);

    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }],
    }, { sessionId: 's1', projectId: 'proj-a' });
    expect(store.get(permissionRulesProjectAllowSetting)).toEqual({ 'proj-a': ['Bash(pnpm test)'] });

    purgeProjectRules(store, 'proj-a');
    expect(store.get(permissionRulesProjectAllowSetting)).toEqual({});
    purgeProjectRules(store, 'nonexistent');
  });

  it('setMode 写 permission.mode 设置', () => {
    const { store } = makeStore();
    applyPermissionUpdate(store, {
      type: 'setMode', destination: 'userSettings', mode: 'acceptEdits',
    }, { sessionId: 's1' });
    expect(store.get(permissionModeSetting)).toBe('acceptEdits');
  });

  it('roundtrip 规范化：等价写法（Bash / Bash() / Bash(*)）只存一条，删除不失配', () => {
    const { store } = makeStore();
    const context = { sessionId: 's1' };
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: '' }],
    }, context);
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash' }],
    }, context);
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: '*' }],
    }, context);

    // 三种写法归一为一条 'Bash'。
    expect(store.get(permissionRulesUserAllowSetting)).toEqual(['Bash']);

    // 删除：按规范化比较，remove 'Bash()' 能删掉存储里的规范形 'Bash'。
    applyPermissionUpdate(store, {
      type: 'removeRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: '' }],
    }, context);
    expect(store.get(permissionRulesUserAllowSetting)).toEqual([]);
  });
});
