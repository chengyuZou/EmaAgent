// 测试路径规则（gitignore 语义）在工作区相对与绝对形态下的命中与越界拒绝。
import { describe, expect, it } from 'vitest';
import { matchPathRule } from '../rules/pathRuleMatching.js';

describe('pathRuleMatching', () => {
  const root = 'D:/work/project';

  it('工作区相对规则命中区内路径', () => {
    expect(matchPathRule('./src/**', 'D:/work/project/src/app/main.ts', root)).toBe(true);
    expect(matchPathRule('src/**', 'D:/work/project/src/app/main.ts', root)).toBe(true);
    expect(matchPathRule('./src/**', 'D:/work/project/other/main.ts', root)).toBe(false);
  });

  it('候选在工作区外直接不命中', () => {
    expect(matchPathRule('./src/**', 'D:/elsewhere/src/a.ts', root)).toBe(false);
  });

  it('无 workspaceRoot 时相对规则不命中（不允许隐式授权）', () => {
    expect(matchPathRule('./src/**', 'D:/work/project/src/a.ts', undefined)).toBe(false);
  });

  it('绝对路径规则（// 前缀）按绝对路径命中', () => {
    expect(matchPathRule('//D:/work/**', 'D:/work/project/a.ts')).toBe(true);
    expect(matchPathRule('//D:/work/**', 'E:/other/a.ts')).toBe(false);
  });

  it('Windows 反斜杠候选按 POSIX 归一后匹配', () => {
    expect(matchPathRule('./src/**', 'D:\\work\\project\\src\\a.ts', root)).toBe(true);
  });
});
