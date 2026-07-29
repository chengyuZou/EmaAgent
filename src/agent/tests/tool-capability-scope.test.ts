// 这里测试 Agent 工具能力只能按名称或稳定 ID 逐层收窄，不能被 Skill 扩大。
import { describe, expect, it } from 'vitest';
import {
  createToolManifestSnapshotFromEntries,
  type ToolManifestEntry,
} from '@ema-agent/tools';
import {
  AgentToolCapabilityScope,
  ToolCapabilityRestrictionError,
} from '../tool-capability-scope.js';
import { TurnPolicy } from '../policy.js';

describe('AgentToolCapabilityScope', () => {
  it('保留 Manifest 固定顺序，并支持名称和稳定 ID glob', () => {
    const scope = new AgentToolCapabilityScope([
      fakeTool('builtin.file.read', 'Read'),
      fakeTool('builtin.shell.bash', 'Bash'),
      fakeTool('mcp.github.search', 'mcp__github__search'),
    ]);

    expect(scope.snapshot().allowedToolNames).toEqual([
      'Read',
      'Bash',
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

describe('TurnPolicy allowedIds', () => {
  it('暴露父 Agent 当前收窄集的只读副本', () => {
    const policy = new TurnPolicy(createToolManifestSnapshotFromEntries([
      fakeTool('tool.read', 'Read'),
      fakeTool('tool.write', 'Write'),
    ], 1));
    policy.capabilities().restrict({
      source: 'skill:readonly',
      allowedToolPatterns: ['Read'],
    });

    const first = policy.allowedIds();
    expect([...first]).toEqual(['tool.read']);
    (first as Set<string>).add('tool.write');

    expect([...policy.allowedIds()]).toEqual(['tool.read']);
  });
});

function fakeTool(id: string, name: string): ToolManifestEntry {
  return {
    id,
    name,
    origin: name.startsWith('mcp__')
      ? { kind: 'mcp', serverName: 'test', serverToolName: name }
      : { kind: 'builtin' },
    description: name,
    inputJsonSchema: {},
  };
}
