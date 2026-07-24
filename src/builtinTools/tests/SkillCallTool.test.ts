// 测试 SkillCall 会把结构化 Skill 正文返回给模型，并立即收窄 Agent 工具能力。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type {
  ToolCapabilityScope,
  ToolCapabilityRestriction,
} from '@ema-agent/tools';
import { SkillCallTool } from '../tools/SkillCallTool/SkillCallTool.js';

describe('SkillCallTool', () => {
  it('应用 allowed-tools 并把实际可用工具返回给模型', async () => {
    const restrict = vi.fn((_restriction: ToolCapabilityRestriction) => ({
      allowedToolNames: ['Read', 'Grep'],
      restrictionSources: ['skill:review'],
    }));

    const result = await SkillCallTool.execute(
      { skill: 'review', args: undefined },
      {
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
      },
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

  it('声明 allowed-tools 但 Agent 未注入能力作用域时 fail closed', () => {
    // 新模式：缺少 toolCapabilities 时 validateContext 投影失败，execute 不会被调用。
    const projection = SkillCallTool.unsafeValidateContext({
      sessionId: asSessionId('session-skill'),
      turnId: asTurnId('turn-skill'),
      workspaceRoot: '',
      signal: new AbortController().signal,
      skillRunner: {
        run: async () => ({ content: 'body', allowedToolPatterns: ['Read'] }),
      },
      // toolCapabilities 刻意不提供，验证 validateContext fail closed
    });
    expect(projection.valid).toBe(false);
  });

  it('未声明 allowed-tools 时保持当前作用域不变', async () => {
    const restrict = vi.fn();

    await expect(
      SkillCallTool.execute(
        { skill: 'plain', args: undefined },
        {
          skillRunner: {
            run: async () => ({ content: 'body', allowedToolPatterns: [] }),
          },
          toolCapabilities: {
            restrict,
            snapshot: () => ({ allowedToolNames: ['Read'], restrictionSources: [] }),
          },
        },
      ),
    ).resolves.toEqual({ skill: 'plain', output: 'body' });
    expect(restrict).not.toHaveBeenCalled();
  });
});
