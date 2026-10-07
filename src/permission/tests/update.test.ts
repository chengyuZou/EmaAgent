// 测试 PermissionUpdate 应用: session 内存表与 settings KV 读写.
import { describe, expect, it } from 'vitest';
import { SettingsStore, type SettingsRepository } from '@ema-agent/settings';
import {
  applyPermissionUpdate,
  clearSessionRules,
  getSessionAllowRules,
} from '../rules/update.js';
import {
  permissionRulesProjectAllowSetting,
  permissionRulesUserAllowSetting,
} from '../settings.js';
import { permissionRuleValueFromString } from '../rules/permissionRuleParser.js';

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

  it('session 授权隔离且保留规则内容的转义', () => {
    const { store } = makeStore();
    const rule = { toolName: 'Mcp', ruleContent: 'input:{"text":"a(b)\\\\c"}' };
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'session', behavior: 'allow', rules: [rule],
    }, { sessionId: 'isolation-one' });
    expect(getSessionAllowRules('isolation-two')).toEqual([]);
    expect(permissionRuleValueFromString(getSessionAllowRules('isolation-one')[0]!)).toEqual(rule);
    clearSessionRules('isolation-one');
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

  it('projectSettings 按 projectId 分桶写；缺 projectId 拒绝', () => {
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
