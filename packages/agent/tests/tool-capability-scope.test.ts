// 这里测试 Agent 工具能力只能按名称或稳定 ID 逐层收窄，不能被 Skill 扩大。
import { describe, expect, it } from 'vitest';
import type { BuiltTool } from '@ema-agent/tools';
import {
  AgentToolCapabilityScope,
  ToolCapabilityRestrictionError,
} from '../src/tool-capability-scope.js';

describe('AgentToolCapabilityScope', () => {
  it('按固定顺序返回工具，并支持名称和稳定 ID glob', () => {
    const scope = new AgentToolCapabilityScope([
      fakeTool('builtin.shell.bash', 'Bash'),
      fakeTool('builtin.file.read', 'Read'),
      fakeTool('mcp.github.search', 'mcp__github__search'),
    ]);

    expect(scope.snapshot().allowedToolNames).toEqual([
      'Bash',
      'Read',
      'mcp__github__search',
    ]);

    expect(scope.restrict({
      source: 'skill:research',
      allowedToolPatterns: ['builtin.file.*', 'mcp__github__*'],
    }).allowedToolNames).toEqual(['Read', 'mcp__github__search']);
  });

  it('连续限制只取交集，空 allowed-tools 不扩大也不收窄', () => {
    const scope = new AgentToolCapabilityScope([
      fakeTool('tool.read', 'Read'),
      fakeTool('tool.grep', 'Grep'),
      fakeTool('tool.write', 'Write'),
    ]);

    scope.restrict({ source: 'skill:first', allowedToolPatterns: ['Read', 'Grep'] });
    scope.restrict({ source: 'skill:empty', allowedToolPatterns: [] });
    const snapshot = scope.restrict({
      source: 'skill:second',
      allowedToolPatterns: ['Grep', 'Write'],
    });

    expect(snapshot.allowedToolNames).toEqual(['Grep']);
    expect(snapshot.restrictionSources).toEqual(['skill:first', 'skill:second']);
    expect(scope.allows('Read')).toBe(false);
    expect(scope.allows('Grep')).toBe(true);
  });

  it('拒绝无法解析到已注册工具的模式，避免拼写错误静默禁用工具', () => {
    const scope = new AgentToolCapabilityScope([fakeTool('tool.read', 'Read')]);

    expect(() => scope.restrict({
      source: 'skill:broken',
      allowedToolPatterns: ['Reed'],
    })).toThrow(ToolCapabilityRestrictionError);
    expect(scope.snapshot().allowedToolNames).toEqual(['Read']);
  });
});

function fakeTool(id: string, name: string): BuiltTool {
  return {
    id,
    name,
    description: name,
    descriptor: () => ({ name, description: name, inputJsonSchema: {} }),
  } as BuiltTool;
}
