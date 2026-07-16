// 这个工具负责加载指定 Skill 的指令，并通过 Skill Runner 注入当前 Agent。
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext, ISkillRunner } from '@ema-agent/tools';
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

  async execute(input: SkillCallInput, ctx: ToolExecutionContext): Promise<SkillCallResult> {
    const skillRunner: ISkillRunner | undefined = ctx.skillRunner;
    if (!skillRunner) {
      throw new Error(
        'Skill runner is not configured. Ensure skills are loaded before using SkillCall.',
      );
    }

    const output = await skillRunner.run(input.skill, input.args, ctx);
    return { skill: input.skill, output };
  },
});
