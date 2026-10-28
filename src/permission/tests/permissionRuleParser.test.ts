import { describe, expect, it } from 'vitest';
import {
  escapeRuleContent,
  matchesWholeTool,
  parsePermissionRuleKey,
  formatPermissionRuleKey,
  unescapeRuleContent,
} from '../rules/permissionRuleParser.js';

describe('permissionRuleParser', () => {
  it('裸 Tool 名与带内容规则的双向解析', () => {
    expect(parsePermissionRuleKey('Bash')).toEqual({ toolName: 'Bash' });
    expect(parsePermissionRuleKey('Bash(npm install)')).toEqual({
      toolName: 'Bash',
      condition: 'npm install',
    });
    expect(formatPermissionRuleKey({ toolName: 'Bash' })).toBe('Bash');
    expect(formatPermissionRuleKey({ toolName: 'Bash', condition: 'npm install' }))
      .toBe('Bash(npm install)');
  });

  it('空内容与通配视为整体 Tool 规则', () => {
    expect(parsePermissionRuleKey('Bash()')).toEqual({ toolName: 'Bash' });
    expect(parsePermissionRuleKey('Bash(*)')).toEqual({ toolName: 'Bash' });
  });

  it('括号与反斜杠转义可逆', () => {
    const raw = 'python -c "print(1)"';
    const escaped = escapeRuleContent(raw);
    expect(unescapeRuleContent(escaped)).toBe(raw);
    const rule = parsePermissionRuleKey(`Bash(${escaped})`);
    expect(rule).toEqual({ toolName: 'Bash', condition: raw });
    expect(formatPermissionRuleKey(rule)).toBe(`Bash(${escaped})`);
  });

  it('残缺形态按裸 Tool 名兜底', () => {
    expect(parsePermissionRuleKey('Bash(npm')).toEqual({ toolName: 'Bash(npm' });
    expect(parsePermissionRuleKey('(foo)')).toEqual({ toolName: '(foo)' });
    expect(parsePermissionRuleKey('Bash(x)tail')).toEqual({ toolName: 'Bash(x)tail' });
  });

  it('matchesWholeTool 只在 condition 为空且同名时命中', () => {
    expect(matchesWholeTool({ toolName: 'Bash' }, 'Bash')).toBe(true);
    expect(matchesWholeTool({ toolName: 'Bash', condition: 'npm' }, 'Bash')).toBe(false);
    expect(matchesWholeTool({ toolName: 'Bash' }, 'Read')).toBe(false);
  });
});
