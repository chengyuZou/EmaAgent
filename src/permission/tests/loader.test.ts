// 测试规则桶装配（user + project + session 并入）与开机项目规则对账。
import { describe, expect, it } from 'vitest';
import { SettingsStore, type SettingsRepository } from '@ema-agent/settings';
import {
  loadPermissionRuleBuckets,
  reconcileProjectRules,
} from '../rules/loader.js';
import { applyPermissionUpdate } from '../rules/update.js';
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

describe('loadPermissionRuleBuckets', () => {
  it('user/project/session 三源分别入桶；无项目时无 projectSettings 键', () => {
    const { store } = makeStore();
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
    }, { sessionId: 's1' });
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }],
    }, { sessionId: 's1', projectId: 'proj-a' });
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'session', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
    }, { sessionId: 's1' });

    const buckets = loadPermissionRuleBuckets(store, 's1', 'proj-a');
    expect(buckets.alwaysAllowRules.userSettings).toEqual(['Bash(npm test)']);
    expect(buckets.alwaysAllowRules.projectSettings).toEqual(['Bash(pnpm test)']);
    expect(buckets.alwaysAllowRules.session).toEqual(['Bash(git status)']);

    const noProject = loadPermissionRuleBuckets(store, 's2');
    expect(noProject.alwaysAllowRules.projectSettings).toBeUndefined();
    expect(noProject.alwaysAllowRules.session).toBeUndefined();
  });

  it('deny/ask 桶按 user/project 装配；session 只进 allow 桶', () => {
    const { store } = makeStore();
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'userSettings', behavior: 'deny',
      rules: [{ toolName: 'Bash', ruleContent: 'rm -rf' }],
    }, { sessionId: 's1' });
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'ask',
      rules: [{ toolName: 'Read', ruleContent: './.env' }],
    }, { sessionId: 's1', projectId: 'proj-a' });
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'session', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
    }, { sessionId: 's1' });

    const buckets = loadPermissionRuleBuckets(store, 's1', 'proj-a');
    expect(buckets.alwaysDenyRules.userSettings).toEqual(['Bash(rm -rf)']);
    expect(buckets.alwaysDenyRules.projectSettings).toBeUndefined();
    expect(buckets.alwaysAskRules.projectSettings).toEqual(['Read(./.env)']);
    // session 只进 allow 桶，deny/ask 桶没有 session 键。
    expect(buckets.alwaysAllowRules.session).toEqual(['Bash(git status)']);
    expect(buckets.alwaysDenyRules.session).toBeUndefined();
    expect(buckets.alwaysAskRules.session).toBeUndefined();
  });

  it('reconcileProjectRules 清理三张 record 的孤儿项目', () => {
    const { store } = makeStore();
    const context = { sessionId: 's1', projectId: 'proj-dead' };
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'a' }],
    }, context);
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'deny',
      rules: [{ toolName: 'Bash', ruleContent: 'b' }],
    }, context);
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'ask',
      rules: [{ toolName: 'Read', ruleContent: 'c' }],
    }, context);

    reconcileProjectRules(store, []);
    expect(store.get(permissionRulesProjectAllowSetting)).toEqual({});
    expect(store.get(permissionRulesProjectDenySetting)).toEqual({});
    expect(store.get(permissionRulesProjectAskSetting)).toEqual({});
  });

  it('reconcileProjectRules 只清理不存在项目的条目，幂等', () => {
    const { store } = makeStore();
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'a' }],
    }, { sessionId: 's1', projectId: 'proj-alive' });
    applyPermissionUpdate(store, {
      type: 'addRules', destination: 'projectSettings', behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'b' }],
    }, { sessionId: 's1', projectId: 'proj-dead' });

    reconcileProjectRules(store, ['proj-alive']);
    expect(store.get(permissionRulesProjectAllowSetting)).toEqual({
      'proj-alive': ['Bash(a)'],
    });
    // 幂等：再跑零变化
    reconcileProjectRules(store, ['proj-alive']);
    expect(store.get(permissionRulesProjectAllowSetting)).toEqual({
      'proj-alive': ['Bash(a)'],
    });
  });
});
