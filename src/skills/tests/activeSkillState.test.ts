// 测试每个 Agent 的 Skill 激活状态隔离、覆盖语义和资源路径投影。
import { describe, expect, it } from 'vitest';
import {
  ActiveSkillState,
  renderActiveSkillContext,
} from '../activeSkillState.js';
import type { ActivatedSkill } from '../types.js';

describe('ActiveSkillState', () => {
  it('重复激活同一 Skill 时保留最后一次参数并支持 fork 隔离', () => {
    const parent = new ActiveSkillState();
    parent.activate(skill('first'));
    parent.activate(skill('second'));

    const child = parent.fork();
    child.activate({ ...skill('child'), skillId: 'child-skill', name: 'child' });

    expect(parent.list()).toHaveLength(1);
    expect(parent.list()[0]?.arguments).toBe('second');
    expect(child.list()).toHaveLength(2);
  });

  it('上下文包含 SKILL.md path 和每个资源文件自己的 path', () => {
    const text = renderActiveSkillContext([skill('review')]);

    expect(text).toContain('path="D:\\skills\\review\\SKILL.md"');
    expect(text).toContain('scripts/check.js (D:\\skills\\review\\scripts\\check.js)');
    expect(text).toContain('脚本仍须通过工具、权限与沙箱执行');
  });
});

function skill(args: string): ActivatedSkill {
  return {
    skillId: 'review-skill',
    name: 'review',
    version: '1.0.0',
    source: 'user',
    path: 'D:\\skills\\review\\SKILL.md',
    rootPath: 'D:\\skills\\review',
    bundleRevision: 'revision',
    arguments: args,
    instructions: `检查 ${args}`,
    allowedToolPatterns: ['FileRead'],
    files: [{
      path: 'D:\\skills\\review\\scripts\\check.js',
      relativePath: 'scripts/check.js',
      kind: 'script',
      sizeBytes: 12,
      sha256: 'hash',
    }],
  };
}
