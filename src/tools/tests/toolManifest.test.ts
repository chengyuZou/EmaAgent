// 测试 Tool Manifest 的确定性、不可变性、来源校验和 MCP 热更新隔离语义。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../Tool/buildTool.js';
import { ToolRegistry } from '../assembly/toolRegistry.js';
import { ToolRegistryError } from '../errors.js';

function makeTool(
  id: string,
  name: string,
  origin: { kind: 'builtin' } | {
    kind: 'mcp';
    serverName: string;
    serverToolName: string;
  } = { kind: 'builtin' },
  result = 'ok',
) {
  return buildTool({
    id,
    name,
    origin,
    description: `${name} description`,
    inputSchema: z.object({ query: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    getPermissionIntent: () => ({
      riskLevel: 'low',
      accessType: 'read',
      promptPolicy: 'neverForTrustedBuiltin',
    }),
    validateContext: () => ({ valid: true, context: {} }),
    execute: async () => result,
  });
}

describe('ToolManifestSnapshot', () => {
  it('按稳定来源分区排序并深冻结 Schema', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('builtin.zeta', 'Alpha'));
    registry.register(makeTool('builtin.alpha', 'Zeta'));
    registry.registerMcp({
      tool: makeTool(
        'mcp.zeta.search',
        'mcp__zeta__search',
        { kind: 'mcp', serverName: 'zeta', serverToolName: 'search' },
      ),
      owner: { serverName: 'zeta', serverToolName: 'search' },
    });
    registry.registerMcp({
      tool: makeTool(
        'mcp.alpha.write',
        'mcp__alpha__write',
        { kind: 'mcp', serverName: 'alpha', serverToolName: 'write' },
      ),
      owner: { serverName: 'alpha', serverToolName: 'write' },
    });

    const first = registry.manifestSnapshot();
    const second = registry.manifestSnapshot([...registry.list()].reverse());

    expect(first.entries.map((entry) => entry.name)).toEqual([
      'Zeta',
      'Alpha',
      'mcp__alpha__write',
      'mcp__zeta__search',
    ]);
    expect(first.revision).toBe(second.revision);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.origin)).toBe(true);
    expect(Object.isFrozen(first.entries[0]?.inputJsonSchema)).toBe(true);
  });

  it('MCP 等价重连不改变内容 revision，且旧 Turn 继续执行冻结实现', async () => {
    const registry = new ToolRegistry();
    const origin = { kind: 'mcp' as const, serverName: 'demo', serverToolName: 'search' };
    registry.registerMcp({
      tool: makeTool('mcp.demo.search', 'mcp__demo__search', origin, 'v1'),
      owner: { serverName: 'demo', serverToolName: 'search' },
    });
    const beforeReconnect = registry.manifestSnapshot();

    expect(() => registry.prepare(
      'mcp__demo__search',
      { query: 'before' },
      { ...beforeReconnect },
    )).toThrow(ToolRegistryError);

    registry.registerMcp({
      tool: makeTool('mcp.demo.search', 'mcp__demo__search', origin, 'v2'),
      owner: { serverName: 'demo', serverToolName: 'search' },
    });
    const afterReconnect = registry.manifestSnapshot();

    expect(afterReconnect.registryVersion).toBeGreaterThan(beforeReconnect.registryVersion);
    expect(afterReconnect.revision).toBe(beforeReconnect.revision);

    const oldTurnCall = registry.prepare(
      'mcp__demo__search',
      { query: 'after' },
      beforeReconnect,
    );
    const nextTurnCall = registry.prepare(
      'mcp__demo__search',
      { query: 'after' },
      afterReconnect,
    );

    await expect(registry.execute(oldTurnCall, {})).resolves.toBe('v1');
    await expect(registry.execute(nextTurnCall, {})).resolves.toBe('v2');
  });

  it('模型可见集合或 Schema 变化时更新内容 revision', () => {
    const registry = new ToolRegistry();
    const alpha = makeTool('builtin.alpha', 'Alpha');
    const beta = makeTool('builtin.beta', 'Beta');
    registry.register(alpha);
    registry.register(beta);

    const complete = registry.manifestSnapshot();
    const restricted = registry.manifestSnapshot([alpha]);

    const changedSchemaRegistry = new ToolRegistry();
    changedSchemaRegistry.register(buildTool({
      id: 'builtin.alpha',
      name: 'Alpha',
      description: 'Alpha description',
      inputSchema: z.object({ query: z.string(), limit: z.number() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      getPermissionIntent: () => ({
        riskLevel: 'low',
        accessType: 'read',
        promptPolicy: 'neverForTrustedBuiltin',
      }),
      validateContext: () => ({ valid: true, context: {} }),
      execute: async () => 'ok',
    }));
    const changedSchema = changedSchemaRegistry.manifestSnapshot();

    expect(restricted.revision).not.toBe(complete.revision);
    expect(changedSchema.revision).not.toBe(restricted.revision);
  });
});
