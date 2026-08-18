// 测试规则字符串与 PermissionRuleValue 的双向转换（转义敏感）与整体 Tool 匹配。
import { describe, expect, it } from 'vitest';
import {
  escapeRuleContent,
  matchesWholeTool,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  unescapeRuleContent,
} from '../rules/permissionRuleParser.js';

describe('permissionRuleParser', () => {
  it('裸 Tool 名与带内容规则的双向解析', () => {
    expect(permissionRuleValueFromString('Bash')).toEqual({ toolName: 'Bash' });
    expect(permissionRuleValueFromString('Bash(npm install)')).toEqual({
      toolName: 'Bash',
      ruleContent: 'npm install',
    });
    expect(permissionRuleValueToString({ toolName: 'Bash' })).toBe('Bash');
    expect(permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'npm install' }))
      .toBe('Bash(npm install)');
  });

  it('空内容与通配视为整体 Tool 规则', () => {
    expect(permissionRuleValueFromString('Bash()')).toEqual({ toolName: 'Bash' });
    expect(permissionRuleValueFromString('Bash(*)')).toEqual({ toolName: 'Bash' });
  });

  it('括号与反斜杠转义可逆', () => {
    const raw = 'python -c "print(1)"';
    const escaped = escapeRuleContent(raw);
    expect(unescapeRuleContent(escaped)).toBe(raw);
    const rule = permissionRuleValueFromString(`Bash(${escaped})`);
    expect(rule).toEqual({ toolName: 'Bash', ruleContent: raw });
    expect(permissionRuleValueToString(rule)).toBe(`Bash(${escaped})`);
  });

  it('残缺形态按裸 Tool 名兜底', () => {
    expect(permissionRuleValueFromString('Bash(npm')).toEqual({ toolName: 'Bash(npm' });
    expect(permissionRuleValueFromString('(foo)')).toEqual({ toolName: '(foo)' });
    expect(permissionRuleValueFromString('Bash(x)tail')).toEqual({ toolName: 'Bash(x)tail' });
  });

  it('matchesWholeTool 只在 ruleContent 为空且同名时命中', () => {
    expect(matchesWholeTool({ toolName: 'Bash' }, 'Bash')).toBe(true);
    expect(matchesWholeTool({ toolName: 'Bash', ruleContent: 'npm' }, 'Bash')).toBe(false);
    expect(matchesWholeTool({ toolName: 'Bash' }, 'Read')).toBe(false);
  });
});
