// 测试每次根 Turn 装配只向模型暴露当前宿主 Context 真正拥有的工具能力。
import { describe, expect, it } from 'vitest';
import {
  assembleToolPool,
  ToolRegistry,
  type ToolUseContext,
} from '@ema-agent/tools';
import { BuiltinTools, registerBuiltinTools } from '../index.js';

function baseContext(): ToolUseContext {
  return {
    workspaceRoot: '',
    platform: process.platform,
  };
}

function visibleNames(context: ToolUseContext): string[] {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  return assembleToolPool(registry, context).tools.map((tool) => tool.name);
}

describe('Builtin ToolPool 能力装配', () => {
  it('无工作区和业务端口时隐藏不可执行工具', () => {
    const names = visibleNames(baseContext());

    expect(names).toContain(BuiltinTools.WebFetch.name);
    expect(names).toContain(BuiltinTools.WebSearch.name);
    expect(names).not.toContain(BuiltinTools.FileRead.name);
    expect(names).not.toContain(BuiltinTools.PdfRead.name);
    expect(names).not.toContain(BuiltinTools.Glob.name);
    expect(names).not.toContain(BuiltinTools.Bash.name);
    expect(names).not.toContain(BuiltinTools.TaskList.name);
    expect(names).not.toContain(BuiltinTools.AskUser.name);
    expect(names).not.toContain(BuiltinTools.Subagent.name);
    expect(names).not.toContain(BuiltinTools.NarrativeSearch.name);
  });

  it('根 Turn 注入能力后只增加对应工具族', () => {
    const context: ToolUseContext = {
      ...baseContext(),
      workspaceRoot: 'D:/workspace',
      readFileState: new Map(),
      taskStore: {} as never,
      askUser: async () => ({ answers: {} }),
      subagentSpawner: {} as never,
      knowledgeSearch: async () => [] as never,
      narrativeSearch: async () => ({
        generationId: 'generation-pool',
        timelines: [],
        contextText: null,
        failures: [],
      }),
      scratchpad: { dir: 'D:/scratchpad', author: 'main' },
    };

    const names = visibleNames(context);

    expect(names).toEqual(expect.arrayContaining([
      BuiltinTools.FileRead.name,
      BuiltinTools.PdfRead.name,
      BuiltinTools.Glob.name,
      BuiltinTools.TaskCreate.name,
      BuiltinTools.AskUser.name,
      BuiltinTools.Subagent.name,
      BuiltinTools.KnowledgeBaseSearch.name,
      BuiltinTools.NarrativeSearch.name,
      BuiltinTools.ScratchpadWrite.name,
    ]));
    expect(names).not.toContain(BuiltinTools.Bash.name);
    expect(names).not.toContain(BuiltinTools.Skill.name);
  });

  it('问询工具显式免普通权限审批(它自己就是询问通道)', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const registered = registry.get(BuiltinTools.AskUser.name);
    expect(registered).toBeDefined();
    expect(registered!.getPermissionIntent({}, {} as never)).toMatchObject({
      promptPolicy: 'neverForTrustedBuiltin',
    });
  });
});
