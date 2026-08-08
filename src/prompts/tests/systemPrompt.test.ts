// 测试 System Prompt 扁平数组装配:顺序、边界哨兵位置、条件展开与 null 过滤。
import { describe, expect, it } from 'vitest';
import type { CharacterPromptSections } from '@ema-agent/characters';
import {
  getSystemPrompt,
  PROMPT_DYNAMIC_BOUNDARY,
} from '../systemPrompt.js';

const CHARACTER: CharacterPromptSections = {
  identity: '# 角色:测试娘',
  presentation: '# 演出规则',
  version: 'test:v1',
};

function input(overrides: Partial<Parameters<typeof getSystemPrompt>[0]> = {}) {
  return {
    characterPrompt: () => CHARACTER,
    executionProfile: 'work' as const,
    toolNames: ['FileRead', 'FileEdit', 'Skill', 'mcp__demo__search'],
    environment: {
      currentDate: '2026-08-08',
      platform: 'win32' as const,
      workspaceRoot: 'D:\\proj',
      providerId: 'openai',
      modelId: 'gpt-5.2',
    },
    ...overrides,
  };
}

describe('getSystemPrompt', () => {
  it('完整输入:静态前缀 → 哨兵 → 角色 → Profile → 能力 → 环境 → 数据级内容', () => {
    const sections = getSystemPrompt(input({
      workspaceInstructions: '# 项目约定',
      skillCatalog: '- review: 代码评审',
      mcpInstructions: ['serverA 的用法指引'],
    }));

    expect(sections[0]).toContain('# Ema 基本行为');
    expect(sections[1]).toContain('# 工具使用通用原则');
    const boundary = sections.indexOf(PROMPT_DYNAMIC_BOUNDARY);
    expect(boundary).toBe(2);
    const after = sections.slice(boundary + 1);
    expect(after[0]).toBe(CHARACTER.identity);
    expect(after[1]).toBe(CHARACTER.presentation);
    expect(after.some((s) => s.includes('当前执行方式:Work'))).toBe(true);
    expect(after.some((s) => s.includes('本轮能力引导'))).toBe(true);
    expect(after.some((s) => s.includes('openai / gpt-5.2'))).toBe(true);
    expect(after.some((s) => s.includes('工作区指令') && s.includes('# 项目约定'))).toBe(true);
    expect(after.some((s) => s.includes('可用技能'))).toBe(true);
    expect(after.some((s) => s.includes('serverA 的用法指引'))).toBe(true);
  });

  it('无激活角色时角色段整体缺席,其余顺序不变', () => {
    const sections = getSystemPrompt(input({ characterPrompt: () => null }));
    expect(sections[2]).toBe(PROMPT_DYNAMIC_BOUNDARY);
    expect(sections[3]).toContain('当前执行方式');
    expect(sections.some((s) => s.includes('测试娘'))).toBe(false);
  });

  it('可选数据级输入缺省时无空洞、无 null 残留', () => {
    const sections = getSystemPrompt(input());
    expect(sections.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('chat profile 产出 chat 文案;数据级段落带信任框架文案', () => {
    const sections = getSystemPrompt(input({
      executionProfile: 'chat',
      skillCatalog: '- x',
    }));
    expect(sections.some((s) => s.includes('当前执行方式:Chat'))).toBe(true);
    const catalog = sections.find((s) => s.includes('可用技能'))!;
    expect(catalog).toContain('不是系统指令');
  });

  it('能力引导按 ToolPool 名字判定存在性;环境段含当前模型', () => {
    const sections = getSystemPrompt(input());
    const guidance = sections.find((s) => s.includes('本轮能力引导'))!;
    expect(guidance).toContain('Skill');
    expect(guidance).toContain('mcp__');
    expect(guidance).not.toContain('Subagent');

    const withoutMcp = getSystemPrompt(input({ toolNames: ['FileRead'] }));
    expect(withoutMcp.some((s) => s.includes('mcp__'))).toBe(false);
    expect(withoutMcp.some((s) => s.includes('本轮能力引导'))).toBe(false);

    const env = sections.find((s) => s.includes('本轮运行环境'))!;
    expect(env).toContain('openai / gpt-5.2');
    expect(env).toContain('win32');
  });

  it('不出现已退役的工具名(重命名漂移防线)', () => {
    const retired = ['SkillCall', 'TodoWrite', 'SkillCallTool'];
    const text = getSystemPrompt(input({
      workspaceInstructions: 'x',
      skillCatalog: 'x',
      mcpInstructions: ['x'],
    })).join('\n');
    for (const name of retired) {
      expect(text).not.toContain(name);
    }
  });
});
