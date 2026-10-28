import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { checkToolPermission, rememberSessionApproval, clearSessionApprovals, type PermissionContext } from '@ema-agent/permission';
import { DEFAULT_MAX_RESULT_BYTES } from '@ema-agent/tools';
import type { McpToolInfo } from '../types.js';
import { buildMcpBuiltTool, discoverServerTools } from '../discovery.js';
import {
  MAX_MCP_TOOLS_PER_SERVER,
  MAX_MCP_TOOL_SCHEMA_BYTES,
} from '../toolSchemaLimits.js';

const PERMISSION_CONTEXT: PermissionContext = {
  mode: 'default',
  sessionId: 'permission-test', rules: [],
  workspaceRoots: [],
};

afterEach(() => clearSessionApprovals(PERMISSION_CONTEXT.sessionId));

describe('MCP 工具发现安全边界', () => {
  it('把取消信号交给 SDK listTools', async () => {
    const controller = new AbortController();
    const listTools = vi.fn(async () => ({ tools: [] }));
    const client = { listTools } as unknown as Client;

    await expect(discoverServerTools('remote', client, controller.signal)).resolves.toEqual([]);

    expect(listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
  });

  it('工具发现失败时上抛, 不能伪装成已连接的空工具 Server', async () => {
    const client = {
      listTools: vi.fn(async () => { throw new Error('list tools failed'); }),
    } as unknown as Client;

    await expect(discoverServerTools('broken', client)).rejects.toThrow('list tools failed');
  });

  it('拒绝超过单 Server 工具数量上限的 live schema', async () => {
    const tools = Array.from(
      { length: MAX_MCP_TOOLS_PER_SERVER + 1 },
      (_, index) => ({
        name: `tool-${index}`,
        inputSchema: { type: 'object' },
      }),
    );
    const client = {
      listTools: vi.fn(async () => ({ tools })),
    } as unknown as Client;

    await expect(discoverServerTools('too-many', client)).rejects.toThrow(
      /reported 257 tools; limit is 256/i,
    );
  });

  it('拒绝总量超过一 MiB 的 live schema', async () => {
    const client = {
      listTools: vi.fn(async () => ({
        tools: [{
          name: 'oversized',
          description: 'x'.repeat(MAX_MCP_TOOL_SCHEMA_BYTES),
          inputSchema: { type: 'object' },
        }],
      })),
    } as unknown as Client;

    await expect(discoverServerTools('oversized', client)).rejects.toThrow(
      /tool schemas use more than 1048576 UTF-8 bytes/i,
    );
  });

  it('保留破坏性提示, 不保存没有消费方的只读提示', async () => {
    const client = {
      listTools: async () => ({
        tools: [{
          name: 'innocent-search',
          description: 'Claims to be read-only',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        }],
      }),
    } as unknown as Client;

    const tools = await discoverServerTools('malicious', client);
    expect(tools[0]).toMatchObject({ reportedDestructive: false });
    expect(tools[0]).not.toHaveProperty('reportedReadOnly');
  });

  it('readOnlyHint 不能让工具自我放行, 也不能开放并发', async () => {
    const client = {
      listTools: async () => ({
        tools: [{ name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      }),
    } as unknown as Client;
    const [info] = await discoverServerTools('test', client);
    const tool = buildMcpBuiltTool(info!, registryStub());

    await expect(checkToolPermission(tool, {}, {}, PERMISSION_CONTEXT, { interactive: true }))
      .resolves.toMatchObject({ decision: 'ask' });
    expect(tool.isReadOnly({})).toBe(false);
    expect(tool.isConcurrencySafe({})).toBe(false);
  });

  it('通过统一 buildTool 保留真实 JSON Schema 并继承 Ema 结果预算', () => {
    const inputSchema = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    };
    const tool = buildMcpBuiltTool(toolInfo({ inputSchema }), registryStub());

    expect(tool.inputJsonSchemaOverride).toEqual(inputSchema);
    expect(tool.origin).toEqual({
      kind: 'mcp',
      serverName: 'test',
      serverToolName: 'search',
    });
    expect(tool.maxResultBytes).toBe(DEFAULT_MAX_RESULT_BYTES);
    expect(tool.requiresUserInteraction({})).toBe(false);
  });

  it('destructiveHint 要求批准, 和 readOnlyHint 冲突时仍要求批准', async () => {
    const client = {
      listTools: async () => ({
        tools: [{
          name: 'search',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: true },
        }],
      }),
    } as unknown as Client;
    const [info] = await discoverServerTools('test', client);
    const destructive = buildMcpBuiltTool(info!, registryStub());

    // Permission 先处理 ask, 所以 bypassPermissions 也不能跳过这一提示.
    await expect(checkToolPermission(destructive, {}, {}, {
      ...PERMISSION_CONTEXT, mode: 'bypassPermissions',
    }, { interactive: true })).resolves.toMatchObject({ decision: 'ask' });
    expect(destructive.isReadOnly({})).toBe(false);
    expect(destructive.isConcurrencySafe({})).toBe(false);
  });

  it('MCP 会话批准仅覆盖当前工具与完整输入, 已批准输入不重复询问', async () => {
    const registry = registryStub();
    const tool = buildMcpBuiltTool(toolInfo({ reportedDestructive: true }), registry);
    const firstInput = tool.inputSchema.parse({ query: 'one', options: { b: 2, a: 1 } });
    const first = await checkToolPermission(tool as never, firstInput, {}, PERMISSION_CONTEXT, { interactive: true });
    expect(first.decision).toBe('ask');
    if (first.decision !== 'ask' || !first.sessionApproval) throw new Error('expected ask');
    rememberSessionApproval(PERMISSION_CONTEXT.sessionId, first.sessionApproval.key);
    const permissions: PermissionContext = {
      ...PERMISSION_CONTEXT,
      rules: [{ key: { toolName: tool.name }, decision: 'ask', from: 'userSettings' }],
    };
    expect((await checkToolPermission(tool as never,
      { options: { a: 1, b: 2 }, query: 'one' }, {}, permissions, { interactive: true })).decision).toBe('allow');
    expect((await checkToolPermission(tool as never,
      { query: 'two', options: { a: 1, b: 2 } }, {}, permissions, { interactive: true })).decision).toBe('ask');
    const other = buildMcpBuiltTool(toolInfo({
      qualifiedName: 'mcp__test__other', serverToolName: 'other',
    }), registry);
    expect((await checkToolPermission(other as never, firstInput, {}, permissions,
      { interactive: true })).decision).toBe('ask');
    expect((await checkToolPermission(tool as never, firstInput, {}, {
      ...permissions, rules: [{ key: { toolName: tool.name }, decision: 'deny', from: 'userSettings' }],
    }, { interactive: true })).decision).toBe('deny');
  });
});

function toolInfo(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    serverToolName: 'search',
    qualifiedName: 'mcp__test__search',
    originalServerName: 'test',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    reportedDestructive: false,
    ...overrides,
  };
}

function registryStub() {
  return { callTool: vi.fn(async () => 'ok') } as never;
}
