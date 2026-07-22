// 测试权限规则查找按 scope 优先级返回确定结果，不依赖数组注入顺序。

import { describe, expect, it } from 'vitest';
import {
  findAllowRule,
  findAskRule,
  findDenyRule,
  ruleMatches,
} from '../rules.js';
import type { PermissionContext, PermissionRule } from '../types.js';

const ctx: Pick<PermissionContext, 'workspaceRoot' | 'sessionId'> = {
  workspaceRoot: '/home/user/project',
  sessionId: 'session-a',
};

const denyGlobal: PermissionRule = { action: 'deny', tool: 'shell', scope: 'global' };
const denyProject: PermissionRule = { action: 'deny', tool: 'shell', scope: 'project' };
const allowGlobal: PermissionRule = { action: 'allow', tool: 'shell', scope: 'global' };
const allowProject: PermissionRule = { action: 'allow', tool: 'shell', scope: 'project' };
const allowSession: PermissionRule = {
  action: 'allow', tool: 'shell', scope: 'session', sessionId: 'session-a',
};
const askGlobal: PermissionRule = { action: 'ask', tool: 'shell', scope: 'global' };
const askProject: PermissionRule = { action: 'ask', tool: 'shell', scope: 'project' };

describe('rule lookup scope priority', () => {
  it('多条 deny 匹配时返回 global（最高优先级），与数组顺序无关', () => {
    expect(findDenyRule([denyProject, denyGlobal], 'shell', undefined, ctx)).toBe(denyGlobal);
    expect(findDenyRule([denyGlobal, denyProject], 'shell', undefined, ctx)).toBe(denyGlobal);
  });

  it('多条 allow 匹配时返回 global，使审计归因确定', () => {
    expect(findAllowRule([allowProject, allowGlobal, allowSession], 'shell', undefined, ctx)).toBe(allowGlobal);
    expect(findAllowRule([allowSession, allowProject, allowGlobal], 'shell', undefined, ctx)).toBe(allowGlobal);
  });

  it('多条 ask 匹配时返回 global', () => {
    expect(findAskRule([askProject, askGlobal], 'shell', undefined, ctx)).toBe(askGlobal);
    expect(findAskRule([askGlobal, askProject], 'shell', undefined, ctx)).toBe(askGlobal);
  });

  it('只有 session 规则时返回 session 规则', () => {
    expect(findAllowRule([allowSession], 'shell', undefined, ctx)).toBe(allowSession);
  });

  it('无匹配时返回 undefined', () => {
    expect(findDenyRule([], 'shell', undefined, ctx)).toBeUndefined();
    expect(findAllowRule([denyGlobal], 'shell', undefined, ctx)).toBeUndefined();
  });

  it('ruleMatches 仍按 sessionId 隔离 session 规则', () => {
    const otherSession: PermissionRule = {
      action: 'allow', tool: 'shell', scope: 'session', sessionId: 'session-b',
    };
    expect(ruleMatches(otherSession, 'shell', undefined, ctx)).toBe(false);
    expect(ruleMatches(allowSession, 'shell', undefined, ctx)).toBe(true);
  });
});
