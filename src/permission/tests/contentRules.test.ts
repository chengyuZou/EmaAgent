// 测试内容级规则查询：Tool 把 input 转成 ruleContent 后查 deny/ask/allow。
import { describe, expect, it } from 'vitest';
import {
  findContentRule,
  findMatchingContentRule,
} from '../hasPermissionsToUseTool.js';
import type { ToolPermissionContext } from '../types.js';

function makeContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  };
}

describe('findContentRule', () => {
  it('命中对应行为桶的规则；整体规则（无 ruleContent）不参与内容匹配', () => {
    const context = makeContext({
      alwaysDenyRules: { userSettings: ['Bash(rm -rf /)', 'Bash'] },
    });
    const rule = findContentRule(context, 'Bash', 'deny', 'rm -rf /');
    expect(rule).toMatchObject({ source: 'userSettings', ruleBehavior: 'deny' });
    // 'Bash' 是整体规则，按内容查不到。
    expect(findContentRule(context, 'Bash', 'deny', 'rm -rf /x')).toBeUndefined();
  });

  it('按 toolName 过滤，别的工具的同名内容不命中', () => {
    const context = makeContext({
      alwaysAskRules: { userSettings: ['Read(./.env)'] },
    });
    expect(findContentRule(context, 'Read', 'ask', './.env')).toBeDefined();
    expect(findContentRule(context, 'FileRead', 'ask', './.env')).toBeUndefined();
  });

  it('source 优先级：session > projectSettings > userSettings', () => {
    const context = makeContext({
      alwaysAllowRules: {
        userSettings: ['Bash(git status)'],
        projectSettings: ['Bash(git status)'],
        session: ['Bash(git status)'],
      },
    });
    const rule = findContentRule(context, 'Bash', 'allow', 'git status');
    expect(rule?.source).toBe('session');
  });

  it('ruleContent 经 unescape：转义括号的规则能按原文命中', () => {
    const context = makeContext({
      alwaysAllowRules: { userSettings: ['Bash(npm test)'] },
    });
    expect(findContentRule(context, 'Bash', 'allow', 'npm test')).toBeDefined();
  });

  it('不匹配任何内容时返回 undefined（该走 passthrough/兜底）', () => {
    const context = makeContext({
      alwaysDenyRules: { userSettings: ['Bash(rm -rf /)'] },
      alwaysAskRules: { userSettings: ['Bash(rm -rf /)'] },
    });
    expect(findContentRule(context, 'Bash', 'deny', 'git status')).toBeUndefined();
    expect(findContentRule(context, 'Bash', 'ask', 'git status')).toBeUndefined();
  });
});

describe('findMatchingContentRule', () => {
  it('谓词匹配 shell 模式规则（Bash(git *)）', () => {
    const context = makeContext({
      alwaysAllowRules: { userSettings: ['Bash(git *)'] },
    });
    const rule = findMatchingContentRule(
      context, 'Bash', 'allow',
      (content) => content === 'git *',
    );
    expect(rule).toMatchObject({ ruleBehavior: 'allow' });
    expect(findMatchingContentRule(
      context, 'Bash', 'allow',
      () => false,
    )).toBeUndefined();
  });
});
