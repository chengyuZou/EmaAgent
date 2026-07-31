// 测试 assembleToolPrompt:可见性过滤、说明书来源、稳定版本与空结果。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool, ToolRegistry, type BuiltTool } from '@ema-agent/tools';
import type { BuiltinToolContext } from '../builtinToolContext.js';
import { assembleToolPrompt } from '../toolPrompt.js';

function makeTool(
  name: string,
  options: {
    requires?: readonly string[];
    prompt?: (context: unknown) => string;
    mcp?: boolean;
  } = {},
): BuiltTool {
  return buildTool({
    name,
    ...(options.mcp
      ? { origin: { kind: 'mcp' as const, serverName: 'srv', serverToolName: name } }
      : {}),
    description: `${name} description`,
    inputSchema: z.object({}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.requires ? { requires: options.requires } : {}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionMeta: { approval: options.mcp ? 'required' as const : 'not_required' as const },
    validateContext: () => ({ valid: true as const, context: undefined }),
    execute: async () => ({}),
  });
}

function makeRegistry(tools: BuiltTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    if (tool.origin.kind === 'mcp') {
      registry.registerMcp({ tool, owner: {
        serverName: tool.origin.serverName,
        serverToolName: tool.origin.serverToolName,
      } });
    } else {
      registry.register(tool);
    }
  }
  return registry;
}

function context(workspaceRoot = '/ws'): BuiltinToolContext {
  return {
    sessionId: 's1' as never,
    turnId: 't1' as never,
    workspaceRoot,
    platform: 'win32',
    signal: new AbortController().signal,
  };
}

describe('assembleToolPrompt', () => {
  it('按可见顺序拼装说明书,MCP 与无 prompt 工具跳过', async () => {
    const registry = makeRegistry([
      makeTool('FileRead', { prompt: () => '读取文件的正确姿势' }),
      makeTool('FileWrite'),
      makeTool('McpThing', { mcp: true, prompt: () => '不可信说明书' }),
    ]);
    const result = await assembleToolPrompt(registry, context());
    expect(result).not.toBeNull();
    expect(result!.content).toBe('## FileRead\n读取文件的正确姿势');
    expect(result!.content).not.toContain('FileWrite');
    expect(result!.content).not.toContain('不可信');
  });

  it('allowedToolIds 白名单收窄(chat 形态)', async () => {
    const registry = makeRegistry([
      makeTool('FileRead', { prompt: () => '读' }),
      makeTool('Bash', { prompt: () => '跑', requires: ['commandRunner'] }),
    ]);
    const wide = await assembleToolPrompt(registry, {
      ...context(),
      commandRunner: {},
    } as BuiltinToolContext);
    expect(wide!.content).toContain('## Bash');

    const narrow = await assembleToolPrompt(registry, {
      ...context(),
      commandRunner: {},
    } as BuiltinToolContext, new Set(['FileRead']));
    expect(narrow!.content).toBe('## FileRead\n读');
  });

  it('narrativeSearch 缺席时依赖它的工具不可见', async () => {
    const registry = makeRegistry([
      makeTool('NarrativeSearch', { prompt: () => '剧情', requires: ['narrativeSearch'] }),
      makeTool('FileRead', { prompt: () => '读' }),
    ]);
    const withNarrative = await assembleToolPrompt(registry, {
      ...context(),
      narrativeSearch: {},
    } as BuiltinToolContext);
    expect(withNarrative!.content).toContain('## NarrativeSearch');

    const without = await assembleToolPrompt(registry, context());
    expect(without!.content).toBe('## FileRead\n读');
  });

  it('同内容版本稳定,内容变化版本变化', async () => {
    const registry = makeRegistry([makeTool('FileRead', { prompt: () => '稳定文本' })]);
    const first = await assembleToolPrompt(registry, context());
    const second = await assembleToolPrompt(registry, context());
    expect(first!.version).toBe(second!.version);

    const changed = makeRegistry([makeTool('FileRead', { prompt: () => '不同文本' })]);
    const third = await assembleToolPrompt(changed, context());
    expect(third!.version).not.toBe(first!.version);
  });

  it('没有说明书工具时返回 null,不产生空槽', async () => {
    const registry = makeRegistry([makeTool('FileRead')]);
    expect(await assembleToolPrompt(registry, context())).toBeNull();
  });
});
