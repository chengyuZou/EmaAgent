// 这里测试 ToolRegistry 的名称所有权、稳定身份和 MCP 批量注册原子性。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../src/build-tool.js';
import {
  ToolRegistrationConflictError,
  ToolRegistry,
} from '../src/registry.js';

function makeTool(name: string, result: string, id = name) {
  return buildTool({
    id,
    name,
    description: '注册所有权测试工具',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionMeta: { riskLevel: 'low', accessType: 'read' },
    execute: async () => result,
  });
}

describe('ToolRegistry MCP 注册所有权', () => {
  it('MCP 不能覆盖内置工具', () => {
    const registry = new ToolRegistry();
    const builtin = makeTool('mcp__system__status', 'builtin');
    registry.register(builtin);

    expect(() => registry.registerMcp({
      tool: makeTool('mcp__system__status', 'mcp'),
      owner: { serverName: 'system', serverToolName: 'status' },
    })).toThrow(ToolRegistrationConflictError);
    expect(registry.get('mcp__system__status')).toBe(builtin);
  });

  it('不同 Server 不能覆盖已经注册的 MCP 工具', () => {
    const registry = new ToolRegistry();
    const name = 'mcp__github_local__search';
    const first = makeTool(name, 'first');
    registry.registerMcp({
      tool: first,
      owner: { serverName: 'github-local', serverToolName: 'search' },
    });

    expect(() => registry.registerMcp({
      tool: makeTool(name, 'second'),
      owner: { serverName: 'github.local', serverToolName: 'search' },
    })).toThrow(ToolRegistrationConflictError);
    expect(registry.get(name)).toBe(first);
  });

  it('同一个原始 MCP 工具重连时可以替换自己的实现', () => {
    const registry = new ToolRegistry();
    const owner = { serverName: 'github-local', serverToolName: 'search.code' };
    registry.registerMcp({ tool: makeTool('mcp__github_local__search_code', 'v1'), owner });
    const first = registry.get('mcp__github_local__search_code');

    registry.registerMcp({ tool: makeTool('mcp__github_local__search_code', 'v2'), owner });
    expect(registry.get('mcp__github_local__search_code')).not.toBe(first);
  });

  it('清洗后同名的不同 MCP 工具整批拒绝且不产生部分注册', () => {
    const registry = new ToolRegistry();
    const name = 'mcp__github_local__search_code';

    expect(() => registry.registerMcpBatch([
      {
        tool: makeTool(name, 'hyphen'),
        owner: { serverName: 'github-local', serverToolName: 'search-code' },
      },
      {
        tool: makeTool(name, 'dot'),
        owner: { serverName: 'github.local', serverToolName: 'search.code' },
      },
    ])).toThrow(/github-local\/search-code.*github\.local\/search\.code/);

    expect(registry.has(name)).toBe(false);
  });

  it('稳定 id 冲突时整批拒绝且不留下先前条目', () => {
    const registry = new ToolRegistry();

    expect(() => registry.registerMcpBatch([
      {
        tool: makeTool('mcp__one__read', 'one', 'mcp.shared.read'),
        owner: { serverName: 'one', serverToolName: 'read' },
      },
      {
        tool: makeTool('mcp__two__read', 'two', 'mcp.shared.read'),
        owner: { serverName: 'two', serverToolName: 'read' },
      },
    ])).toThrow('Tool id "mcp.shared.read" is shared');

    expect(registry.has('mcp__one__read')).toBe(false);
    expect(registry.has('mcp__two__read')).toBe(false);
  });

  it('准备调用时同时保留模型名称和内部稳定 id', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('Edit', 'ok', 'builtin.file.edit'));

    expect(registry.prepare('Edit', {})).toEqual(expect.objectContaining({
      id: 'builtin.file.edit',
      name: 'Edit',
    }));
  });

  it('错误所有者不能注销其他 MCP Server 的工具', () => {
    const registry = new ToolRegistry();
    const name = 'mcp__server_a__read';
    const owner = { serverName: 'server-a', serverToolName: 'read' };
    registry.registerMcp({ tool: makeTool(name, 'A'), owner });

    expect(registry.unregisterMcp(name, {
      serverName: 'server-b',
      serverToolName: 'read',
    })).toBe(false);
    expect(registry.has(name)).toBe(true);

    expect(registry.unregisterMcp(name, owner)).toBe(true);
    expect(registry.has(name)).toBe(false);
  });
});
