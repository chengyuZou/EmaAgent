// 这里测试 ToolRegistry 的名称所有权、稳定身份和 MCP 批量注册原子性。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../build-tool.js';
import {
  ToolRegistrationConflictError,
  ToolRegistry,
} from '../registry.js';

function makeTool(name: string, result: string, id = name) {
  return buildTool({
    id,
    name,
    description: '注册所有权测试工具',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionMeta: { riskLevel: 'low', accessType: 'read' },
    validateContext: () => ({ valid: true, context: {} }),
    execute: async () => result,
  });
}

function makeMcpTool(
  name: string,
  result: string,
  owner: { serverName: string; serverToolName: string },
  id = name,
) {
  return buildTool({
    id,
    name,
    origin: { kind: 'mcp', ...owner },
    description: 'MCP 注册所有权测试工具',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionMeta: { riskLevel: 'low', accessType: 'read' },
    validateContext: () => ({ valid: true, context: {} }),
    execute: async () => result,
  });
}

describe('ToolRegistry MCP 注册所有权', () => {
  it('MCP 来源必须显式声明，并与注册所有者完全一致', () => {
    const registry = new ToolRegistry();
    const owner = { serverName: 'server-a', serverToolName: 'read' };

    expect(() => registry.registerMcp({
      tool: makeTool('mcp__server_a__read', 'builtin-shaped'),
      owner,
    })).toThrow(/origin does not match/);

    expect(() => registry.register(
      makeMcpTool('mcp__server_a__read', 'mcp-shaped', owner),
    )).toThrow(/must use registerMcp/);
  });

  it('MCP 不能覆盖内置工具', () => {
    const registry = new ToolRegistry();
    const builtin = makeTool('mcp__system__status', 'builtin');
    const owner = { serverName: 'system', serverToolName: 'status' };
    registry.register(builtin);

    expect(() => registry.registerMcp({
      tool: makeMcpTool('mcp__system__status', 'mcp', owner),
      owner,
    })).toThrow(ToolRegistrationConflictError);
    expect(registry.get('mcp__system__status')).toBe(builtin);
  });

  it('不同 Server 不能覆盖已经注册的 MCP 工具', () => {
    const registry = new ToolRegistry();
    const name = 'mcp__github_local__search';
    const firstOwner = { serverName: 'github-local', serverToolName: 'search' };
    const first = makeMcpTool(name, 'first', firstOwner);
    registry.registerMcp({
      tool: first,
      owner: firstOwner,
    });

    const secondOwner = { serverName: 'github.local', serverToolName: 'search' };
    expect(() => registry.registerMcp({
      tool: makeMcpTool(name, 'second', secondOwner),
      owner: secondOwner,
    })).toThrow(ToolRegistrationConflictError);
    expect(registry.get(name)).toBe(first);
  });

  it('同一个原始 MCP 工具重连时可以替换自己的实现', () => {
    const registry = new ToolRegistry();
    const owner = { serverName: 'github-local', serverToolName: 'search.code' };
    registry.registerMcp({ tool: makeMcpTool('mcp__github_local__search_code', 'v1', owner), owner });
    const first = registry.get('mcp__github_local__search_code');

    registry.registerMcp({ tool: makeMcpTool('mcp__github_local__search_code', 'v2', owner), owner });
    expect(registry.get('mcp__github_local__search_code')).not.toBe(first);
  });

  it('清洗后同名的不同 MCP 工具整批拒绝且不产生部分注册', () => {
    const registry = new ToolRegistry();
    const name = 'mcp__github_local__search_code';
    const hyphenOwner = { serverName: 'github-local', serverToolName: 'search-code' };
    const dotOwner = { serverName: 'github.local', serverToolName: 'search.code' };

    expect(() => registry.registerMcpBatch([
      {
        tool: makeMcpTool(name, 'hyphen', hyphenOwner),
        owner: hyphenOwner,
      },
      {
        tool: makeMcpTool(name, 'dot', dotOwner),
        owner: dotOwner,
      },
    ])).toThrow(/github-local\/search-code.*github\.local\/search\.code/);

    expect(registry.has(name)).toBe(false);
  });

  it('稳定 id 冲突时整批拒绝且不留下先前条目', () => {
    const registry = new ToolRegistry();
    const oneOwner = { serverName: 'one', serverToolName: 'read' };
    const twoOwner = { serverName: 'two', serverToolName: 'read' };

    expect(() => registry.registerMcpBatch([
      {
        tool: makeMcpTool('mcp__one__read', 'one', oneOwner, 'mcp.shared.read'),
        owner: oneOwner,
      },
      {
        tool: makeMcpTool('mcp__two__read', 'two', twoOwner, 'mcp.shared.read'),
        owner: twoOwner,
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
    registry.registerMcp({ tool: makeMcpTool(name, 'A', owner), owner });

    expect(registry.unregisterMcp(name, {
      serverName: 'server-b',
      serverToolName: 'read',
    })).toBe(false);
    expect(registry.has(name)).toBe(true);

    expect(registry.unregisterMcp(name, owner)).toBe(true);
    expect(registry.has(name)).toBe(false);
  });
});
