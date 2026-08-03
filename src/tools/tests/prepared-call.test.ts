// 测试 PreparedToolCall 的输入冻结、归属校验和执行一致性。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../Tool/buildTool.js';
import { ToolRegistry } from '../assembly/toolRegistry.js';
import { ToolRegistryError } from '../errors.js';
import type { BuiltTool } from '../Tool/tool.js';

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
    getPermissionIntent: input => ({
      riskLevel: 'medium',
      accessType: 'write',
      targets: [{ path: input.path, accessType: 'write' }],
      promptPolicy: 'whenRequired',
    }),
    execute: async (input) => `${input.path}:${input.parallel}`,
  });
}

describe('PreparedToolCall', () => {
  it('只解析一次，并让并发判断和执行共享规范化输入', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());

    const raw = { path: 'notes.txt', parallel: true };
    const prepared = registry.prepare('dynamic_tool', raw, registry.manifestSnapshot());

    expect(prepared.input).toEqual(raw);
    expect(prepared.summary).toBe('处理 notes.txt');
    expect(prepared.input).not.toBe(raw);
    expect(prepared.origin).toEqual({ kind: 'builtin' });
    expect(prepared.isReadOnly).toBe(true);
    expect(prepared.isConcurrencySafe).toBe(true);
    expect(prepared.requiresUserInteraction).toBe(false);
    expect(prepared.maxResultBytes).toBe(4096);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    const projected = registry.validateContext(prepared, context);
    expect(projected.valid).toBe(true);
    if (!projected.valid) throw new Error(projected.reason);
    await expect(registry.permissionIntent(prepared, projected.context)).resolves.toEqual({
      riskLevel: 'medium',
      accessType: 'write',
      targets: [{ path: 'notes.txt', accessType: 'write' }],
      promptPolicy: 'whenRequired',
    });
    await expect(registry.execute(prepared, context)).resolves.toBe('notes.txt:true');
  });

  it('在同一 Prepared 输入上执行权限前业务校验', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());

    const manifest = registry.manifestSnapshot();
    const valid = registry.prepare(
      'dynamic_tool',
      { path: 'question.txt', parallel: false },
      manifest,
    );
    expect(valid.requiresUserInteraction).toBe(true);
    await expect(registry.validate(valid, context)).resolves.toEqual({ valid: true });

    const invalid = registry.prepare(
      'dynamic_tool',
      { path: 'blocked.txt', parallel: false },
      manifest,
    );
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
      getPermissionIntent: () => ({
        riskLevel: 'low',
        accessType: 'read',
        promptPolicy: 'neverForTrustedBuiltin',
      }),
      validateContext: () => ({ valid: true, context: {} }),
      execute: async () => 'ok',
    });
    registry.register(nestedTool);

    const prepared = registry.prepare(
      'nested_tool',
      { nested: { value: 'approved' } },
      registry.manifestSnapshot(),
    );
    expect(Object.isFrozen(prepared.input.nested)).toBe(true);
    expect(() => {
      (prepared.input.nested as { value: string }).value = 'changed';
    }).toThrow(TypeError);
    expect(prepared.input.nested.value).toBe('approved');
  });

  it('拒绝伪造与跨 Registry 调用，并保留热更新前的执行绑定', async () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    const origin = { kind: 'mcp' as const, serverName: 'test', serverToolName: 'dynamic' };
    first.registerMcp({
      tool: makeTool('mcp__test__dynamic', origin),
      owner: { serverName: 'test', serverToolName: 'dynamic' },
    });
    second.register(makeTool('mcp__test__dynamic'));

    const manifest = first.manifestSnapshot();
    const prepared = first.prepare(
      'mcp__test__dynamic',
      { path: 'a.txt' },
      manifest,
    );
    await expect(second.execute(prepared, context)).rejects.toBeInstanceOf(ToolRegistryError);

    first.registerMcp({
      tool: makeTool('mcp__test__dynamic', origin),
      owner: { serverName: 'test', serverToolName: 'dynamic' },
    });
    await expect(first.execute(prepared, context)).resolves.toBe('a.txt:false');

    await expect(first.execute({
      id: 'mcp__test__dynamic',
      name: 'mcp__test__dynamic',
      origin,
      input: { path: 'a.txt', parallel: false },
      isReadOnly: true,
      isConcurrencySafe: false,
      requiresUserInteraction: false,
      maxResultBytes: 4096,
    }, context)).rejects.toThrow(/not created by this registry/);
  });
});

describe('MCP 权限意图', () => {
  it('远端声明不能把 MCP 工具降成低风险免询问', async () => {
    const tool = buildTool({
      id: 'remote_tool',
      name: 'remote_tool',
      description: '远端工具',
      origin: {
        kind: 'mcp',
        serverName: 'remote',
        serverToolName: 'remote_tool',
      },
      inputSchema: z.object({}),
      getPermissionIntent: () => ({
        riskLevel: 'low',
        accessType: 'read',
        promptPolicy: 'neverForTrustedBuiltin',
      }),
      validateContext: () => ({ valid: true, context: {} }),
      execute: async () => 'ok',
    });
    await expect(tool.getPermissionIntent({}, {})).resolves.toEqual({
      riskLevel: 'medium',
      accessType: 'execute',
      promptPolicy: 'whenRequired',
    });
  });
});
