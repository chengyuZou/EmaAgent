// 测试 SkillCall 会把结构化 Skill 正文返回给模型，并立即收窄 Agent 工具能力。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type {
  ToolCapabilityScope,
  ToolExecutionScope,
  ToolInvocationContext,
  ToolCapabilityRestriction,
} from '@ema-agent/tools';
import { SkillCallTool } from '../tools/SkillCallTool/SkillCallTool.js';

describe('SkillCallTool', () => {
  it('应用 allowed-tools 并把实际可用工具返回给模型', async () => {
    const restrict = vi.fn((_restriction: ToolCapabilityRestriction) => ({
      allowedToolNames: ['Read', 'Grep'],
      restrictionSources: ['skill:review'],
    }));
    const context = makeContext({
      skillRunner: {
        run: async () => ({
          content: '请阅读并复查代码',
          allowedToolPatterns: ['Read', 'Grep'],
        }),
      },
      toolCapabilities: {
        restrict,
        snapshot: () => ({ allowedToolNames: [], restrictionSources: [] }),
      } satisfies ToolCapabilityScope,
    });

    const result = await SkillCallTool.execute(
      { skill: 'review', args: undefined },
      ...context,
    );

    expect(restrict).toHaveBeenCalledWith({
      source: 'skill:review',
      allowedToolPatterns: ['Read', 'Grep'],
    });
    expect(result).toEqual({
      skill: 'review',
      output: '请阅读并复查代码',
      availableTools: ['Read', 'Grep'],
    });
  });

  it('声明 allowed-tools 但 Agent 未注入能力作用域时 fail closed', async () => {
    const context = makeContext({
      skillRunner: {
        run: async () => ({ content: 'body', allowedToolPatterns: ['Read'] }),
      },
    });

    await expect(
      SkillCallTool.execute({ skill: 'review', args: undefined }, ...context),
    ).rejects.toThrow('capability scope is unavailable');
  });

  it('未声明 allowed-tools 时保持当前作用域不变', async () => {
    const restrict = vi.fn();
    const context = makeContext({
      skillRunner: {
        run: async () => ({ content: 'body', allowedToolPatterns: [] }),
      },
      toolCapabilities: {
        restrict,
        snapshot: () => ({ allowedToolNames: ['Read'], restrictionSources: [] }),
      },
    });

    await expect(
      SkillCallTool.execute({ skill: 'plain', args: undefined }, ...context),
    ).resolves.toEqual({ skill: 'plain', output: 'body' });
    expect(restrict).not.toHaveBeenCalled();
  });
});

function makeContext(
  overrides: Partial<ToolExecutionScope>,
): [ToolInvocationContext, ToolExecutionScope] {
  return [{
    sessionId: asSessionId('session-skill'),
    turnId: asTurnId('turn-skill'),
    toolCallId: asToolCallId('skill-tool-call'),
    workspaceRoot: '',
    signal: new AbortController().signal,
  }, {
    readFileState: new Map(),
    ...overrides,
  }];
}
