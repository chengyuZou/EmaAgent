// 测试 ToolRegistry 单一库存、稳定 ID 约束和 MCP 原子更新与来源注销。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../assembly/toolRegistry.js';
import { buildTool } from '../Tool/buildTool.js';
import { ToolRegistrationConflictError } from '../errors.js';

function makeBuiltin(name: string, id = name) {
  return buildTool({
    id,
    name,
    description: 'Registry 测试用内置工具',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    getPermissionIntent: () => ({
      riskLevel: 'low',
      accessType: 'read',
      promptPolicy: 'neverForTrustedBuiltin',
    }),
    validateContext: () => ({ valid: true, context: {} }),
    execute: async () => 'ok',
  });
}

function makeMcp(
  name: string,
  serverName: string,
  serverToolName: string,
  id = name,
) {
  return buildTool({
    id,
    name,
    origin: { kind: 'mcp', serverName, serverToolName },
    description: 'Registry 测试用 MCP 工具',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    getPermissionIntent: () => ({
      riskLevel: 'medium',
      accessType: 'execute',
      promptPolicy: 'whenRequired',
    }),
    validateContext: () => ({ valid: true, context: {} }),
    execute: async () => 'ok',
  });
}

describe('ToolRegistry', () => {
  it('Builtin 与 MCP 必须从各自入口注册', () => {
    const registry = new ToolRegistry();

    expect(() => registry.register(
      makeMcp('mcp__remote__read', 'remote', 'read'),
    )).toThrow(/registerMcpBatch/);
    expect(() => registry.registerMcpBatch([
      makeBuiltin('Read'),
    ])).toThrow(/must use register/);
  });

  it('直接保存并返回同一个 Tool 对象', () => {
    const registry = new ToolRegistry();
    const tool = makeBuiltin('Read', 'builtin.file.read');

    registry.register(tool);

    expect(registry.get('Read')).toBe(tool);
    expect(registry.list()).toEqual([tool]);
  });

  it('名称或稳定 ID 冲突不会产生第二份注册状态', () => {
    const registry = new ToolRegistry();
    const read = makeBuiltin('Read', 'builtin.file.read');
    registry.register(read);

    expect(() => registry.register(makeBuiltin('Read', 'another.id')))
      .toThrow(/already registered/);
    expect(() => registry.register(makeBuiltin('ReadAgain', 'builtin.file.read')))
      .toThrow(/already registered by "Read"/);
    expect(registry.list()).toEqual([read]);
  });

  it('MCP 不能覆盖 Builtin 或其他原始 MCP 来源', () => {
    const registry = new ToolRegistry();
    const builtin = makeBuiltin('mcp__system__status');
    registry.register(builtin);

    expect(() => registry.registerMcpBatch([
      makeMcp('mcp__system__status', 'system', 'status'),
    ])).toThrow(ToolRegistrationConflictError);
    expect(registry.get('mcp__system__status')).toBe(builtin);

    const first = makeMcp('mcp__remote__read', 'remote-a', 'read');
    registry.registerMcpBatch([first]);
    expect(() => registry.registerMcpBatch([
      makeMcp('mcp__remote__read', 'remote-b', 'read'),
    ])).toThrow(ToolRegistrationConflictError);
    expect(registry.get('mcp__remote__read')).toBe(first);
  });

  it('同一原始 MCP 工具重连时替换实现', () => {
    const registry = new ToolRegistry();
    const first = makeMcp('mcp__remote__read', 'remote', 'read');
    const second = makeMcp('mcp__remote__read', 'remote', 'read');

    registry.registerMcpBatch([first]);
    registry.registerMcpBatch([second]);

    expect(registry.get('mcp__remote__read')).toBe(second);
  });

  it('MCP 整批冲突时不留下部分注册', () => {
    const registry = new ToolRegistry();
    const one = makeMcp('mcp__one__read', 'one', 'read', 'mcp.shared.read');
    const two = makeMcp('mcp__two__read', 'two', 'read', 'mcp.shared.read');

    expect(() => registry.registerMcpBatch([one, two]))
      .toThrow(/is shared/);
    expect(registry.list()).toEqual([]);
  });

  it('只按 Tool 自有原始来源注销 MCP 实现', () => {
    const registry = new ToolRegistry();
    const tool = makeMcp('mcp__remote__read', 'remote', 'read');
    registry.registerMcpBatch([tool]);

    expect(registry.unregisterMcp('other', 'read')).toBe(false);
    expect(registry.get(tool.name)).toBe(tool);
    expect(registry.unregisterMcp('remote', 'read')).toBe(true);
    expect(registry.get(tool.name)).toBeUndefined();
  });
});
