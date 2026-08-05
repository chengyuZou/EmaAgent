// 测试 CommandRunner 必须由 LocalHost 提供明确工作区，不能借用 Sidecar 当前目录。

import { describe, expect, it } from 'vitest';
import { CommandRunner } from '../commandRunner.js';

describe('CommandRunner 工作区边界', () => {
  it('空 workspaceRoot 直接拒绝构造', () => {
    expect(() => new CommandRunner({
      workspaceRoot: '',
      writablePaths: [],
      forbiddenPaths: [],
      networkAccess: 'none',
    })).toThrow('需要明确的 workspaceRoot');
  });
});
