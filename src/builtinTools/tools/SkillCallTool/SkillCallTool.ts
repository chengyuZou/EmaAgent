// 加载指定 Skill 的指令，并通过 Skill Runner 注入当前 Agent。
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type {
  SkillRunnerPort,
  ToolExecutionScope,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  skill: z.string().min(1).describe('Skill name (the /skill-name identifier without the slash).'),
  args: z.string().optional().describe('Optional arguments string passed to the skill.'),
});

type SkillCallInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface SkillCallResult {
  skill: string;
  output: string;
  /** Skill 限制生效后，下一次模型调用实际可见的工具名称。 */
  availableTools?: readonly string[];
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const SkillCallTool = buildTool<SkillCallInput, SkillCallResult>({
  id: BuiltinTools.SkillCall.id,
  name: BuiltinTools.SkillCall.name,
  description: `Invoke a named Skill (slash command) and return its output.

Skills are pre-defined prompt templates or automation sequences registered in settings. The agent can use this to run complex multi-step skills as a single atomic action.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'medium',
    accessType: 'execute',
  },

  async execute(input: SkillCallInput, _ctx, scope: ToolExecutionScope): Promise<SkillCallResult> {
    const skillRunner: SkillRunnerPort | undefined = scope.skillRunner;
    if (!skillRunner) {
      throw new Error(
        'Skill runner is not configured. Ensure skills are loaded before using SkillCall.',
      );
    }

    const activation = await skillRunner.run(input.skill, input.args);
    if (activation.allowedToolPatterns.length === 0) {
      return { skill: input.skill, output: activation.content };
    }

    if (!scope.toolCapabilities) {
      throw new Error(
        `Skill "${input.skill}" declares allowed-tools, but the Agent capability scope is unavailable.`,
      );
    }

    const snapshot = scope.toolCapabilities.restrict({
      source: `skill:${input.skill}`,
      allowedToolPatterns: activation.allowedToolPatterns,
    });
    return {
      skill: input.skill,
      output: activation.content,
      availableTools: snapshot.allowedToolNames,
    };
  },
});
