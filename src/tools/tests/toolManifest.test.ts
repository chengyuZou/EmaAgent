// 测试 Tool Manifest 的确定性、不可变性、来源校验和 MCP 热更新失效语义。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../build-tool.js';
import { ToolRegistry, ToolRegistryError } from '../registry.js';

function makeTool(
  id: string,
  name: string,
  origin: { kind: 'builtin' } | {
    kind: 'mcp';
    serverName: string;
    serverToolName: string;
  } = { kind: 'builtin' },
) {
  return buildTool({
    id,
    name,
    origin,
    description: `${name} description`,
    inputSchema: z.object({ query: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionMeta: { riskLevel: 'low', accessType: 'read' },
    execute: async () => 'ok',
  });
}

describe('ToolManifestSnapshot', () => {
  it('按工具名稳定排序并深冻结 Schema', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('tool.zeta', 'Zeta'));
    registry.register(makeTool('tool.alpha', 'Alpha'));

    const first = registry.manifestSnapshot();
    const second = registry.manifestSnapshot([...registry.list()].reverse());

    expect(first.entries.map((entry) => entry.name)).toEqual(['Alpha', 'Zeta']);
    expect(first.revision).toBe(second.revision);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(first.entries.every((entry) => entry.origin.kind === 'builtin')).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.origin)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.inputJsonSchema)).toBe(true);
  });

  it('拒绝伪造 Manifest，并在同名 MCP 实现热更新后拒绝旧快照', () => {
    const registry = new ToolRegistry();
    const origin = { kind: 'mcp' as const, serverName: 'demo', serverToolName: 'search' };
    registry.registerMcp({
      tool: makeTool('mcp.demo.search', 'mcp__demo__search', origin),
      owner: { serverName: 'demo', serverToolName: 'search' },
    });
    const snapshot = registry.manifestSnapshot();

    expect(() => registry.prepare(
      'mcp__demo__search',
      { query: 'before' },
      { ...snapshot },
    )).toThrow(ToolRegistryError);

    registry.registerMcp({
      tool: makeTool('mcp.demo.search', 'mcp__demo__search', origin),
      owner: { serverName: 'demo', serverToolName: 'search' },
    });

    expect(() => registry.prepare(
      'mcp__demo__search',
      { query: 'after' },
      snapshot,
    )).toThrow(/stale/);
  });
});
