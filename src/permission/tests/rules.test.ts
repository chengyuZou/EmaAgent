// 测试权限规则查找按 scope 优先级返回确定结果，不依赖数组注入顺序。

import { describe, expect, it } from 'vitest';
import {
  findAllowRule,
  findAskRule,
  findDenyRule,
  ruleMatches,
} from '../policy/permissionRules.js';
import type { PermissionContext, PermissionRule } from '../types.js';

const workspaceRoot = '/home/user/project';
const ctx: Pick<PermissionContext, 'workspaceRoot'> = {
  workspaceRoot,
};

const denyGlobal: PermissionRule = { action: 'deny', tool: 'shell', scope: 'global' };
const denyWorkspace: PermissionRule = {
  action: 'deny', tool: 'shell', scope: 'workspace', workspaceRoot,
};
const allowGlobal: PermissionRule = { action: 'allow', tool: 'shell', scope: 'global' };
const allowWorkspace: PermissionRule = {
  action: 'allow', tool: 'shell', scope: 'workspace', workspaceRoot,
};
const askGlobal: PermissionRule = { action: 'ask', tool: 'shell', scope: 'global' };
const askWorkspace: PermissionRule = {
  action: 'ask', tool: 'shell', scope: 'workspace', workspaceRoot,
};

describe('rule lookup scope priority', () => {
  it('多条 deny 匹配时返回 global（最高优先级），与数组顺序无关', () => {
    expect(findDenyRule([denyWorkspace, denyGlobal], 'shell', undefined, ctx)).toBe(denyGlobal);
    expect(findDenyRule([denyGlobal, denyWorkspace], 'shell', undefined, ctx)).toBe(denyGlobal);
  });

  it('多条 allow 匹配时返回 global，使审计归因确定', () => {
    expect(findAllowRule([allowWorkspace, allowGlobal], 'shell', undefined, ctx)).toBe(allowGlobal);
    expect(findAllowRule([allowGlobal, allowWorkspace], 'shell', undefined, ctx)).toBe(allowGlobal);
  });

  it('多条 ask 匹配时返回 global', () => {
    expect(findAskRule([askWorkspace, askGlobal], 'shell', undefined, ctx)).toBe(askGlobal);
    expect(findAskRule([askGlobal, askWorkspace], 'shell', undefined, ctx)).toBe(askGlobal);
  });

  it('只有 workspace 规则时返回 workspace 规则', () => {
    expect(findAllowRule([allowWorkspace], 'shell', undefined, ctx)).toBe(allowWorkspace);
  });

  it('无匹配时返回 undefined', () => {
    expect(findDenyRule([], 'shell', undefined, ctx)).toBeUndefined();
    expect(findAllowRule([denyGlobal], 'shell', undefined, ctx)).toBeUndefined();
  });

  it('ruleMatches 按 workspaceRoot 隔离 workspace 规则', () => {
    const otherWorkspace: PermissionRule = {
      action: 'allow', tool: 'shell', scope: 'workspace', workspaceRoot: '/other/workspace',
    };
    expect(ruleMatches(otherWorkspace, 'shell', undefined, ctx)).toBe(false);
    expect(ruleMatches(allowWorkspace, 'shell', undefined, ctx)).toBe(true);
  });

  it('workspace 规则在无 workspaceRoot 的 context 中不匹配', () => {
    const emptyCtx: Pick<PermissionContext, 'workspaceRoot'> = { workspaceRoot: '' };
    expect(ruleMatches(allowWorkspace, 'shell', undefined, emptyCtx)).toBe(false);
  });
});
