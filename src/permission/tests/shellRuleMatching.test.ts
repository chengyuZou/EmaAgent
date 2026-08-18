// 测试 shell 规则三形态（exact / `:*` 前缀 / wildcard）与 matchShellRule 判定。
import { describe, expect, it } from 'vitest';
import {
  hasWildcards,
  matchShellRule,
  matchWildcardPattern,
  parsePermissionRule,
} from '../rules/shellRuleMatching.js';

describe('shellRuleMatching', () => {
  it('三形态判别', () => {
    expect(parsePermissionRule('npm test')).toEqual({ type: 'exact', command: 'npm test' });
    expect(parsePermissionRule('npm:*')).toEqual({ type: 'prefix', prefix: 'npm' });
    expect(parsePermissionRule('npm run *')).toEqual({ type: 'wildcard', pattern: 'npm run *' });
    expect(hasWildcards('npm run *')).toBe(true);
    expect(hasWildcards('npm:*')).toBe(false);
    expect(hasWildcards(String.raw`npm run \*`)).toBe(false);
  });

  it('exact 全串相等', () => {
    expect(matchShellRule('npm test', 'npm test')).toBe(true);
    expect(matchShellRule('npm test', 'npm test --watch')).toBe(false);
  });

  it('prefix 边界：`npm:*` 命中 npm 及其参数，不命中 npmx', () => {
    expect(matchShellRule('npm:*', 'npm')).toBe(true);
    expect(matchShellRule('npm:*', 'npm install')).toBe(true);
    expect(matchShellRule('npm:*', 'npmx install')).toBe(false);
  });

  it('wildcard：`*` 匹配任意序列，转义星号为字面量', () => {
    expect(matchWildcardPattern('npm run *', 'npm run test --watch')).toBe(true);
    expect(matchWildcardPattern('npm run *', 'npm build')).toBe(false);
    expect(matchWildcardPattern(String.raw`echo \*`, 'echo *')).toBe(true);
    expect(matchWildcardPattern(String.raw`echo \*`, 'echo star')).toBe(false);
  });

  it("末尾 ' *' 唯一通配可选化：'git *' 同时匹配 'git add' 与裸 'git'", () => {
    expect(matchWildcardPattern('git *', 'git add')).toBe(true);
    expect(matchWildcardPattern('git *', 'git')).toBe(true);
    expect(matchWildcardPattern('* run *', 'npm run')).toBe(false);
  });

  it('matchShellRule 按形态分发', () => {
    expect(matchShellRule('git status', 'git status')).toBe(true);
    expect(matchShellRule('pnpm run *', 'pnpm run build')).toBe(true);
  });
});
