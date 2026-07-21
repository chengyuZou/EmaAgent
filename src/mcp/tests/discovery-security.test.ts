// 这里测试 MCP Server 自报的安全 annotations 不能降低权限风险或开放并发执行。
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PermissionEngine } from '@ema-agent/permission';
import type { McpToolInfo } from '../types.js';
import { McpToolInfoListSchema } from '../types.js';
import { buildMcpBuiltTool, discoverServerTools } from '../discovery.js';

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

  it('readOnlyHint 不能生成 low/read 权限，也不能开放并发', async () => {
    const tool = buildMcpBuiltTool(toolInfo({ reportedReadOnly: true }), registryStub());
    const ask = vi.fn(async () => ({ action: 'deny' as const }));
    const permission = new PermissionEngine({ mode: 'auto', rules: [], ask });

    expect(tool.permissionMeta).toEqual({ riskLevel: 'medium', accessType: 'execute' });
    expect(tool.isReadOnly({})).toBe(false);
    expect(tool.isConcurrencySafe({})).toBe(false);

    const outcome = await permission.gate(
      { id: tool.id, name: tool.name },
      {},
      tool.permissionMeta,
      { workspaceRoot: '', sessionId: 'session-mcp' },
    );

    expect(outcome.granted).toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      toolId: tool.id,
      toolName: tool.name,
      riskLevel: 'medium',
      accessType: 'execute',
    }));
  });

  it('destructiveHint 只能单向提升到 high，和 readOnlyHint 冲突时仍按 high', () => {
    const destructive = buildMcpBuiltTool(
      toolInfo({ reportedReadOnly: true, reportedDestructive: true }),
      registryStub(),
    );

    expect(destructive.permissionMeta).toEqual({
      riskLevel: 'high',
      accessType: 'execute',
    });
    expect(destructive.isReadOnly({})).toBe(false);
    expect(destructive.isConcurrencySafe({})).toBe(false);
  });

  it('旧缓存字段只迁移为远端提示，不恢复旧的安全语义', () => {
    const parsed = McpToolInfoListSchema.parse([{
      serverToolName: 'legacy',
      qualifiedName: 'mcp__test__legacy',
      originalServerName: 'test',
      description: 'legacy cache',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      isDestructive: false,
    }]);

    expect(parsed[0]).toMatchObject({
      reportedReadOnly: true,
      reportedDestructive: false,
    });
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
