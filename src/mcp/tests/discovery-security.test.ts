// 测试 MCP Server 的动态 Schema、结果预算和自报 annotations 都受 Ema Tool 契约约束。
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolPermissionContext } from '@ema-agent/permission';
import { DEFAULT_MAX_RESULT_BYTES } from '@ema-agent/tools';
import type { McpToolInfo } from '../types.js';
import { buildMcpBuiltTool, discoverServerTools } from '../discovery.js';
import {
  MAX_MCP_TOOLS_PER_SERVER,
  MAX_MCP_TOOL_SCHEMA_BYTES,
} from '../toolSchemaLimits.js';

const PERMISSION_CONTEXT: ToolPermissionContext = {
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
};

describe('MCP 工具发现安全边界', () => {
  it('把取消信号交给 SDK listTools', async () => {
    const controller = new AbortController();
    const listTools = vi.fn(async () => ({ tools: [] }));
    const client = { listTools } as unknown as Client;

    await expect(discoverServerTools('remote', client, controller.signal)).resolves.toEqual([]);

    expect(listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
  });

  it('工具发现失败时上抛，不能伪装成已连接的空工具 Server', async () => {
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

  it('保留远端 annotations 供展示，但明确标记为 reported hints', async () => {
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

    await expect(discoverServerTools('malicious', client)).resolves.toEqual([
      expect.objectContaining({
        reportedReadOnly: true,
        reportedDestructive: false,
      }),
    ]);
  });

  it('readOnlyHint 不能让工具自我放行，也不能开放并发', async () => {
    const tool = buildMcpBuiltTool(toolInfo({ reportedReadOnly: true }), registryStub());

    // passthrough = "我没有放行理由,交中央收口"——远端自报 readOnly 换不来 allow。
    await expect(tool.checkPermissions({}, {}, PERMISSION_CONTEXT))
      .resolves.toMatchObject({ behavior: 'passthrough' });
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

  it('destructiveHint 单向升级为强制询问，和 readOnlyHint 冲突时仍升级', async () => {
    const destructive = buildMcpBuiltTool(
      toolInfo({ reportedReadOnly: true, reportedDestructive: true }),
      registryStub(),
    );

    // ask 在中央优先级里先于 bypassPermissions——远端自报破坏性无法被模式跳过。
    await expect(destructive.checkPermissions({}, {}, PERMISSION_CONTEXT))
      .resolves.toMatchObject({
        behavior: 'ask',
        decisionReason: { type: 'safetyCheck', reason: 'destructiveHint' },
      });
    expect(destructive.isReadOnly({})).toBe(false);
    expect(destructive.isConcurrencySafe({})).toBe(false);
  });
});

function toolInfo(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    serverToolName: 'search',
    qualifiedName: 'mcp__test__search',
    originalServerName: 'test',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    reportedReadOnly: false,
    reportedDestructive: false,
    ...overrides,
  };
}

function registryStub() {
  return { callTool: vi.fn(async () => 'ok') } as never;
}
