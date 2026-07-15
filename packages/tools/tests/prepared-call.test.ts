import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../src/build-tool.js';
import { ToolRegistry, ToolRegistryError } from '../src/registry.js';
import type { BuiltTool, ToolExecutionContext } from '../src/types.js';

const context = {
  sessionId: 'session-test',
  turnId: 'turn-test',
  workspaceRoot: 'D:/workspace',
  signal: new AbortController().signal,
  readFileState: new Map(),
} satisfies ToolExecutionContext;

function makeTool(name = 'dynamic_tool'): BuiltTool<{ path: string; parallel: boolean }, string> {
  return buildTool({
    name,
    description: '测试工具',
    inputSchema: z.object({
      path: z.string(),
      parallel: z.boolean().default(false),
    }),
    isReadOnly: (input) => input.path.endsWith('.txt'),
    isConcurrencySafe: (input) => input.parallel,
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
    expect(prepared.input).not.toBe(raw);
    expect(prepared.isReadOnly).toBe(true);
    expect(prepared.isConcurrencySafe).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(Object.isFrozen(prepared.permissionMeta)).toBe(true);
    await expect(registry.execute(prepared, context)).resolves.toBe('notes.txt:true');
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
    first.registerMcp({
      tool: makeTool('mcp__test__dynamic'),
      owner: { serverName: 'test', serverToolName: 'dynamic' },
    });
    second.register(makeTool('mcp__test__dynamic'));

    const prepared = first.prepare('mcp__test__dynamic', { path: 'a.txt' });
    await expect(second.execute(prepared, context)).rejects.toBeInstanceOf(ToolRegistryError);

    first.registerMcp({
      tool: makeTool('mcp__test__dynamic'),
      owner: { serverName: 'test', serverToolName: 'dynamic' },
    });
    await expect(first.execute(prepared, context)).rejects.toThrow(/stale/);

    await expect(first.execute({
      name: 'mcp__test__dynamic',
      input: { path: 'a.txt', parallel: false },
      isReadOnly: true,
      isConcurrencySafe: false,
      permissionMeta: { riskLevel: 'low' },
    }, context)).rejects.toThrow(/not created by this registry/);
  });
});
