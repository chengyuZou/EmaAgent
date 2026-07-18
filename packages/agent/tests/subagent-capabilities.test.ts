// 测试 Subagent 只向模型公布已注入运行能力支撑的工具。

import { describe, expect, it } from 'vitest';
import { BuiltinTools } from '@ema-agent/tool-builtin';
import type { BuiltTool } from '@ema-agent/tools';
import { selectSubagentTools } from '../src/subagent-capabilities.js';

describe('selectSubagentTools', () => {
  const tools = [
    fakeTool(BuiltinTools.FileRead.id, BuiltinTools.FileRead.name),
    fakeTool(BuiltinTools.Bash.id, BuiltinTools.Bash.name),
    fakeTool(BuiltinTools.AskUser.id, BuiltinTools.AskUser.name),
    fakeTool(BuiltinTools.Subagent.id, BuiltinTools.Subagent.name),
    fakeTool(BuiltinTools.WebFetch.id, BuiltinTools.WebFetch.name),
    fakeTool(BuiltinTools.TodoWrite.id, BuiltinTools.TodoWrite.name),
    fakeTool(BuiltinTools.ScratchpadRead.id, BuiltinTools.ScratchpadRead.name),
    fakeTool(BuiltinTools.KnowledgeBaseSearch.id, BuiltinTools.KnowledgeBaseSearch.name),
    fakeTool(BuiltinTools.SkillCall.id, BuiltinTools.SkillCall.name),
    fakeTool('mcp.server.lookup', 'server__lookup'),
  ];

  it('无可选桥时隐藏工作区、交互、递归和桥接工具', () => {
    expect(selectSubagentTools(tools, {
      scratchpad: false,
      knowledgeBase: false,
      skills: false,
    }).map(tool => tool.name)).toEqual([
      BuiltinTools.WebFetch.name,
      BuiltinTools.TodoWrite.name,
      'server__lookup',
    ]);
  });

  it('只为实际注入的 Scratchpad、KB 与 Skill 恢复对应工具', () => {
    expect(selectSubagentTools(tools, {
      scratchpad: true,
      knowledgeBase: true,
      skills: true,
    }).map(tool => tool.name)).toEqual([
      BuiltinTools.WebFetch.name,
      BuiltinTools.TodoWrite.name,
      BuiltinTools.ScratchpadRead.name,
      BuiltinTools.KnowledgeBaseSearch.name,
      BuiltinTools.SkillCall.name,
      'server__lookup',
    ]);
  });
});

function fakeTool(id: string, name: string): BuiltTool {
  return { id, name } as BuiltTool;
}
