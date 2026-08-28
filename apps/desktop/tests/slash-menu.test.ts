// 测试斜杠菜单的触发判定与过滤：未闭合 token 只允许位于文本开头或末尾。
import { describe, expect, it } from 'vitest';
import { matchesSlashQuery, slashQuery } from '../src/chat/input/slashMenu.js';

describe('slashQuery', () => {
  it('输入框最开头的 / 触发，返回已键入过滤词', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/com')).toBe('com');
    expect(slashQuery('/compact')).toBe('compact');
  });

  it('文本中间的 / 不触发', () => {
    expect(slashQuery('1/2 的概率')).toBeNull();
    expect(slashQuery('and/or')).toBeNull();
    expect(slashQuery('你好/')).toBeNull();
    expect(slashQuery('')).toBeNull();
  });

  it('空白分隔的末尾 token 可以触发', () => {
    expect(slashQuery('请分析这个文件 /')).toBe('');
    expect(slashQuery('请分析这个文件 /code')).toBe('code');
  });

  it('命令 token 含空白即离开命令态', () => {
    expect(slashQuery('/compact ')).toBeNull();
    expect(slashQuery('/skill name')).toBeNull();
  });
});

describe('matchesSlashQuery', () => {
  it('空过滤词放行全部', () => {
    expect(matchesSlashQuery('compact', '')).toBe(true);
  });

  it('大小写不敏感的包含匹配', () => {
    expect(matchesSlashQuery('compact', 'com')).toBe(true);
    expect(matchesSlashQuery('compact', 'COMP')).toBe(true);
    expect(matchesSlashQuery('compact', 'pac')).toBe(true);
    expect(matchesSlashQuery('compact', 'skill')).toBe(false);
  });
});
