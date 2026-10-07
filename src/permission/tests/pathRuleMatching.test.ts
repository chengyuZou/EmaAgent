// 测试路径规则（gitignore 语义）在工作区相对与绝对形态下的命中与越界拒绝。
import { describe, expect, it } from 'vitest';
import { directoryPathToRuleContent, filePathToRuleContent, matchPathRule } from '../rules/pathRuleMatching.js';

describe('pathRuleMatching', () => {
  const root = 'D:/work/project';

  it('单文件规则按字面路径匹配, 不批准目录或相似文件', () => {
    const file = `${root}/[one]*.ts`;
    const content = filePathToRuleContent(file);
    expect(matchPathRule(content, file)).toBe(true);
    expect(matchPathRule(content, `${root}/one.ts`)).toBe(false);
    expect(matchPathRule(content, `${file}/child`)).toBe(false);
    expect(matchPathRule(content, `${root}/other.ts`)).toBe(false);
    expect(matchPathRule(content, file.replace(/\//g, '\\'))).toBe(true);
  });

  it('目录批准包含目录本身及后代, 不包含相邻目录', () => {
    const directory = `${root}/[data]`;
    const content = directoryPathToRuleContent(directory);
    expect(matchPathRule(content, directory)).toBe(true);
    expect(matchPathRule(content, `${directory}/child/a.ts`)).toBe(true);
    expect(matchPathRule(content, `${directory}-other/a.ts`)).toBe(false);
    expect(matchPathRule(content, `${root}/d/a.ts`)).toBe(false);
  });

  it('工作区相对规则命中区内路径', () => {
    expect(matchPathRule('./src/**', 'D:/work/project/src/app/main.ts', root)).toBe(true);
    expect(matchPathRule('src/**', 'D:/work/project/src/app/main.ts', root)).toBe(true);
    expect(matchPathRule('./src/**', 'D:/work/project/other/main.ts', root)).toBe(false);
  });

  it('候选在工作区外直接不命中', () => {
    expect(matchPathRule('./src/**', 'D:/elsewhere/src/a.ts', root)).toBe(false);
  });

  it('无 cwd 时相对规则不命中（不允许隐式授权）', () => {
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
