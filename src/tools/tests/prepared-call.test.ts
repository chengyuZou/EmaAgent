// 测试 PreparedToolCall 的输入冻结、归属校验和执行一致性。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../build-tool.js';
import { ToolRegistry } from '../registry.js';
import { ToolRegistryError } from '../errors.js';
import type { BuiltTool } from '../types.js';

const context = {
  signal: new AbortController().signal,
};

function makeTool(
  name = 'dynamic_tool',
  origin: { kind: 'builtin' } | {
    kind: 'mcp';
    serverName: string;
    serverToolName: string;
  } = { kind: 'builtin' },
): BuiltTool<{ path: string; parallel: boolean }, string> {
  return buildTool({
    name,
    origin,
    description: '测试工具',
    getToolUseSummary: (input) => `处理 ${input.path}`,
    inputSchema: z.object({
      path: z.string(),
      parallel: z.boolean().default(false),
    }),
    maxResultBytes: 4096,
    validateContext: () => ({ valid: true, context: {} }),
    validateInput: async input => input.path === 'blocked.txt'
      ? { valid: false, message: '路径被业务规则拒绝', code: 'tool/path_blocked' }
      : { valid: true },
    isReadOnly: (input) => input.path.endsWith('.txt'),
    isConcurrencySafe: (input) => input.parallel,
    requiresUserInteraction: input => input.path === 'question.txt',
    permissionMeta: {
      riskLevel: 'medium',
      accessType: 'write',
      extractPath: (input) => (input as { path: string }).path,
    },
    execute: async (input) => `${input.path}:${input.parallel}`,
  });
}

describe('PreparedToolCall', () => {
  it('只解析一次，并让并发判断和执行共享规范化输入', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());

    const raw = { path: 'notes.txt', parallel: true };
    const prepared = registry.prepare('dynamic_tool', raw);

    expect(prepared.input).toEqual(raw);
    expect(prepared.summary).toBe('处理 notes.txt');
    expect(prepared.input).not.toBe(raw);
    expect(prepared.origin).toEqual({ kind: 'builtin' });
    expect(prepared.isReadOnly).toBe(true);
    expect(prepared.isConcurrencySafe).toBe(true);
    expect(prepared.requiresUserInteraction).toBe(false);
    expect(prepared.maxResultBytes).toBe(4096);
    expect(prepared.permissionMeta.approval).toBe('required');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(Object.isFrozen(prepared.permissionMeta)).toBe(true);
    await expect(registry.execute(prepared, context)).resolves.toBe('notes.txt:true');
  });

  it('在同一 Prepared 输入上执行权限前业务校验', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());

    const valid = registry.prepare('dynamic_tool', { path: 'question.txt', parallel: false });
    expect(valid.requiresUserInteraction).toBe(true);
    await expect(registry.validate(valid, context)).resolves.toEqual({ valid: true });

    const invalid = registry.prepare('dynamic_tool', { path: 'blocked.txt', parallel: false });
    await expect(registry.validate(invalid, context)).resolves.toEqual({
      valid: false,
      message: '路径被业务规则拒绝',
      code: 'tool/path_blocked',
    });
  });

  it('深冻结嵌套输入，审批后不能原地改参', () => {
    const registry = new ToolRegistry();
    const nestedTool = buildTool({
      name: 'nested_tool',
      description: '嵌套参数测试',
      inputSchema: z.object({ nested: z.object({ value: z.string() }) }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      permissionMeta: { riskLevel: 'low', accessType: 'read' },
      validateContext: () => ({ valid: true, context: {} }),
      execute: async () => 'ok',
    });
    registry.register(nestedTool);

    const prepared = registry.prepare('nested_tool', { nested: { value: 'approved' } });
    expect(Object.isFrozen(prepared.input.nested)).toBe(true);
    expect(() => {
      (prepared.input.nested as { value: string }).value = 'changed';
    }).toThrow(TypeError);
    expect(prepared.input.nested.value).toBe('approved');
  });

  it('拒绝伪造、跨 Registry 和热更新前的旧快照', async () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    const origin = { kind: 'mcp' as const, serverName: 'test', serverToolName: 'dynamic' };
    first.registerMcp({
      tool: makeTool('mcp__test__dynamic', origin),
      owner: { serverName: 'test', serverToolName: 'dynamic' },
    });
    second.register(makeTool('mcp__test__dynamic'));

    const prepared = first.prepare('mcp__test__dynamic', { path: 'a.txt' });
    await expect(second.execute(prepared, context)).rejects.toBeInstanceOf(ToolRegistryError);

    first.registerMcp({
      tool: makeTool('mcp__test__dynamic', origin),
      owner: { serverName: 'test', serverToolName: 'dynamic' },
    });
    await expect(first.execute(prepared, context)).rejects.toThrow(/stale/);

    await expect(first.execute({
      id: 'mcp__test__dynamic',
      name: 'mcp__test__dynamic',
      origin,
      input: { path: 'a.txt', parallel: false },
      isReadOnly: true,
      isConcurrencySafe: false,
      requiresUserInteraction: false,
      maxResultBytes: 4096,
      permissionMeta: { riskLevel: 'low' },
    }, context)).rejects.toThrow(/not created by this registry/);
  });
});

describe('工具审批声明', () => {
  it('拒绝 MCP 工具声明 not_required', () => {
    expect(() => buildTool({
      id: 'remote_tool',
      name: 'remote_tool',
      description: '远端工具',
      origin: {
        kind: 'mcp',
        serverName: 'remote',
        serverToolName: 'remote_tool',
      },
      inputSchema: z.object({}),
      permissionMeta: {
        approval: 'not_required',
        riskLevel: 'low',
      },
      validateContext: () => ({ valid: true, context: {} }),
      execute: async () => 'ok',
    })).toThrow('Only trusted builtin tools');
  });
});
