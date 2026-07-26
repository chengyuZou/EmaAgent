// 测试 SkillCall 会把结构化 Skill 正文返回给模型，并立即收窄 Agent 工具能力。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type {
  ToolCapabilityScope,
  ToolCapabilityRestriction,
} from '@ema-agent/tools';
import {
  ActiveSkillState,
  type ActivatedSkill,
} from '@ema-agent/skills';
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
        activeSkillState: new ActiveSkillState(),
        skillRunner: {
          run: async () => activation('review', ['Read', 'Grep']),
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
      path: 'D:\\skills\\review\\SKILL.md',
      rootPath: 'D:\\skills\\review',
      bundleRevision: 'revision',
      output: '请阅读并复查代码',
      files: [],
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
        run: async () => activation('review', ['Read']),
      },
      activeSkillState: new ActiveSkillState(),
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
          activeSkillState: new ActiveSkillState(),
          skillRunner: {
            run: async () => activation('plain', []),
          },
          toolCapabilities: {
            restrict,
            snapshot: () => ({ allowedToolNames: ['Read'], restrictionSources: [] }),
          },
        },
      ),
    ).resolves.toEqual({
      skill: 'plain',
      path: 'D:\\skills\\plain\\SKILL.md',
      rootPath: 'D:\\skills\\plain',
      bundleRevision: 'revision',
      output: 'body',
      files: [],
    });
    expect(restrict).not.toHaveBeenCalled();
  });

  it('激活结果进入当前 Agent 状态，并保留 SKILL.md path', async () => {
    const activeSkillState = new ActiveSkillState();
    await SkillCallTool.execute(
      { skill: 'review', args: 'src' },
      {
        activeSkillState,
        skillRunner: { run: async () => activation('review', []) },
        toolCapabilities: {
          restrict: vi.fn(),
          snapshot: () => ({ allowedToolNames: [], restrictionSources: [] }),
        },
      },
    );

    expect(activeSkillState.list()[0]).toEqual(expect.objectContaining({
      path: 'D:\\skills\\review\\SKILL.md',
      instructions: '请阅读并复查代码',
    }));
  });

  it('把 Bundle 中每个文件的独立 path 返回给模型', async () => {
    const skill = activation('review', []);
    const activationWithFiles: ActivatedSkill = {
      ...skill,
      files: [{
        path: 'D:\\skills\\review\\references\\rules.md',
        relativePath: 'references/rules.md',
        kind: 'reference',
        sizeBytes: 128,
        sha256: 'file-sha256',
      }],
    };

    await expect(
      SkillCallTool.execute(
        { skill: 'review', args: undefined },
        {
          activeSkillState: new ActiveSkillState(),
          skillRunner: { run: async () => activationWithFiles },
          toolCapabilities: {
            restrict: vi.fn(),
            snapshot: () => ({ allowedToolNames: [], restrictionSources: [] }),
          },
        },
      ),
    ).resolves.toEqual(expect.objectContaining({
      path: 'D:\\skills\\review\\SKILL.md',
      files: [{
        path: 'D:\\skills\\review\\references\\rules.md',
        relativePath: 'references/rules.md',
        kind: 'reference',
      }],
    }));
  });
});

function activation(
  name: string,
  allowedToolPatterns: readonly string[],
): ActivatedSkill {
  return {
    skillId: `skill-${name}`,
    name,
    version: '1.0.0',
    source: 'user',
    path: `D:\\skills\\${name}\\SKILL.md`,
    rootPath: `D:\\skills\\${name}`,
    bundleRevision: 'revision',
    instructions: name === 'review' ? '请阅读并复查代码' : 'body',
    allowedToolPatterns,
    files: [],
  };
}
