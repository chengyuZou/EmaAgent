import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext, ISkillRunner } from '@ema-agent/tools';

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  skill: z.string().min(1).describe('Skill name (the /skill-name identifier without the slash).'),
  args: z.string().optional().describe('Optional arguments string passed to the skill.'),
});

type SkillCallInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface SkillCallResult {
  skill: string;
  output: string;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const skillCallTool = buildTool<SkillCallInput, SkillCallResult>({
  name: 'skill_call',
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
        'Skill runner is not configured. Ensure skills are loaded before using skill_call.',
      );
    }

    const output = await skillRunner.run(input.skill, input.args, ctx);
    return { skill: input.skill, output };
  },
});
