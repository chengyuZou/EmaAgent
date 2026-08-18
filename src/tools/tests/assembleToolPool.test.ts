// 测试根 Turn ToolPool 的能力筛选、稳定顺序、对象复用和 Registry 热更新隔离。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assembleToolPool } from '../assembly/assembleToolPool.js';
import { ToolRegistry } from '../assembly/toolRegistry.js';
import { buildTool } from '../Tool/buildTool.js';
import { contextFail, contextOk } from '../Tool/tool.js';
import type { ToolUseContext } from '../Tool/toolUseContext.js';

const baseContext: ToolUseContext = {
  workspaceRoot: 'D:/workspace',
  platform: 'win32',
};

function makeTool(
  id: string,
  name: string,
  capability: 'always' | 'workspace' | 'askUser',
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
    inputSchema: z.object({}),
    validateContext: (context: ToolUseContext) => {
      if (capability === 'workspace' && !context.workspaceRoot) {
        return contextFail('缺少工作区');
      }
      if (capability === 'askUser' && !context.askUser) {
        return contextFail('缺少用户问询端口');
      }
      return contextOk({});
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    execute: async () => 'ok',
  });
}

describe('assembleToolPool', () => {
  it('只保留 Context 投影成功的 Tool，并复用原 Tool 对象', () => {
    const registry = new ToolRegistry();
    const always = makeTool('builtin.always', 'Always', 'always');
    const workspace = makeTool('builtin.workspace', 'Workspace', 'workspace');
    registry.register(always);
    registry.register(workspace);
    registry.register(makeTool('builtin.ask', 'Ask', 'askUser'));

    const pool = assembleToolPool(registry, baseContext);

    expect(pool.tools).toEqual([always, workspace]);
    expect(pool.get('Always')).toBe(always);
    expect(pool.get('Ask')).toBeUndefined();
    expect(Object.isFrozen(pool.tools)).toBe(true);
  });

  it('Builtin 是稳定前缀，MCP 按原始来源形成稳定后缀', () => {
    const registry = new ToolRegistry();
    const mcpZ = makeTool(
      'mcp.z',
      'mcp__z__read',
      'always',
      { kind: 'mcp', serverName: 'z', serverToolName: 'read' },
    );
    const builtinZ = makeTool('builtin.z', 'Zed', 'always');
    const builtinA = makeTool('builtin.a', 'Alpha', 'always');
    const mcpA = makeTool(
      'mcp.a',
      'mcp__a__read',
      'always',
      { kind: 'mcp', serverName: 'a', serverToolName: 'read' },
    );
    registry.register(builtinZ);
    registry.register(builtinA);
    registry.registerMcpBatch([mcpZ, mcpA]);

    expect(assembleToolPool(registry, baseContext).tools)
      .toEqual([builtinA, builtinZ, mcpA, mcpZ]);
  });

  it('Registry 热更新不改变已建立的根 Turn ToolPool', () => {
    const registry = new ToolRegistry();
    const first = makeTool(
      'mcp.remote.read',
      'mcp__remote__read',
      'always',
      { kind: 'mcp', serverName: 'remote', serverToolName: 'read' },
    );
    registry.registerMcpBatch([first]);
    const currentTurn = assembleToolPool(registry, baseContext);

    const reconnected = makeTool(
      'mcp.remote.read',
      'mcp__remote__read',
      'always',
      { kind: 'mcp', serverName: 'remote', serverToolName: 'read' },
    );
    registry.registerMcpBatch([reconnected]);
    const nextTurn = assembleToolPool(registry, baseContext);

    expect(currentTurn.get(first.name)).toBe(first);
    expect(nextTurn.get(first.name)).toBe(reconnected);
  });
});
