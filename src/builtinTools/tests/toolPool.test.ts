// 测试每次 Agent 执行只向模型暴露当前宿主 Context 真正拥有的工具能力。
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@ema-agent/tools';
import {
  assembleToolPool,
  BuiltinTools,
  registerBuiltinTools,
  type BuiltinToolContext,
} from '../index.js';

function baseContext(): BuiltinToolContext {
  return {
    sessionId: 'session-pool' as BuiltinToolContext['sessionId'],
    turnId: 'turn-pool' as BuiltinToolContext['turnId'],
    workspaceRoot: '',
    signal: new AbortController().signal,
  };
}

function visibleNames(context: BuiltinToolContext): string[] {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  return assembleToolPool(registry, context).map((tool) => tool.name);
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
    const context: BuiltinToolContext = {
      ...baseContext(),
      workspaceRoot: 'D:/workspace',
      readFileState: new Map(),
      taskStore: {} as never,
      askUser: async () => ({ answers: {} }),
      subagentSpawner: {} as never,
      knowledgeSearch: async () => [] as never,
      narrativeSearch: async () => ({
        timelines: [],
        contextText: null,
        failedTimelineCount: 0,
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
    expect(names).not.toContain(BuiltinTools.SkillCall.name);
  });

  it('四种纯问询工具显式免普通权限审批', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    for (const tool of [
      BuiltinTools.AskUser,
      BuiltinTools.AskText,
      BuiltinTools.AskChoice,
      BuiltinTools.AskConfirm,
    ]) {
      expect(registry.get(tool.name)?.permissionMeta.approval).toBe('not_required');
    }
  });
});
