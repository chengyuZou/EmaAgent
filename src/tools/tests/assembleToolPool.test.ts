// 测试 ToolPool 只按工具声明的宿主能力过滤，并保留 Registry 中跨来源候选。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assembleToolPool } from '../assembly/assembleToolPool.js';
import { buildTool } from '../Tool/buildTool.js';
import { ToolRegistry } from '../assembly/toolRegistry.js';

interface HostContext {
  readonly workspaceRoot: string;
  readonly search?: object;
}

function makeTool(
  id: string,
  name: string,
  requires?: readonly (keyof HostContext)[],
  origin: { kind: 'builtin' } | {
    kind: 'mcp';
    serverName: string;
    serverToolName: string;
  } = { kind: 'builtin' },
) {
  return buildTool<{}, string, HostContext, {}>({
    id,
    name,
    origin,
    description: `${name} description`,
    inputSchema: z.object({}),
    requires,
    validateContext: () => ({ valid: true, context: {} }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    getPermissionIntent: () => ({
      riskLevel: 'low',
      accessType: 'read',
      promptPolicy: 'neverForTrustedBuiltin',
    }),
    execute: async () => 'ok',
  });
}

describe('assembleToolPool', () => {
  it('保留无依赖工具和能力齐备工具，隐藏缺少能力的工具', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('builtin.always', 'Always'));
    registry.register(makeTool('builtin.workspace', 'Workspace', ['workspaceRoot']));
    registry.register(makeTool('builtin.search', 'Search', ['search']));

    expect(assembleToolPool(registry, {
      workspaceRoot: 'D:/workspace',
    } satisfies HostContext).map((tool) => tool.name)).toEqual([
      'Always',
      'Workspace',
    ]);
  });

  it('Builtin 与 MCP 使用同一 Registry 和同一能力过滤规则', () => {
    const registry = new ToolRegistry();
    const builtin = makeTool('builtin.read', 'Read', ['workspaceRoot']);
    const owner = { serverName: 'github', serverToolName: 'search' };
    const mcp = makeTool(
      'mcp.github.search',
      'mcp__github__search',
      ['search'],
      { kind: 'mcp', ...owner },
    );
    registry.register(builtin);
    registry.registerMcp({ tool: mcp, owner });

    expect(assembleToolPool(registry, {
      workspaceRoot: 'D:/workspace',
    } satisfies HostContext)).toEqual([builtin]);
    expect(assembleToolPool(registry, {
      workspaceRoot: 'D:/workspace',
      search: {},
    } satisfies HostContext)).toEqual([builtin, mcp]);
  });
});
