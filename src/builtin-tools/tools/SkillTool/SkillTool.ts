import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolUseContext,
} from '@ema-agent/tools';
import {
  type SkillPool,
} from '@ema-agent/skills';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { SKILL_DESCRIPTION } from './prompt.js';

/** 只接受当前 Turn 准备好的技能池. */
interface SkillToolContext {
  skillPool: SkillPool;
}

const inputSchema = z.object({
  name: z.string().min(1).max(128).describe(
    'The skill name exactly as shown in the available skills listing.',
  ),
  path: z.string().min(1).describe(
    'The absolute SKILL.md path exactly as shown in the available skills listing.',
  ),
}).strict();

type SkillInput = z.infer<typeof inputSchema>;

export interface SkillToolResult {
  name: string;
  path: string;
  version?: string;
  description: string;
  whenToUse?: string;
  /** 完整 SKILL.md, 包含 frontmatter 和正文. */
  instructions: string;
}

export const SkillTool = buildTool<SkillInput, SkillToolResult, SkillToolContext>({
  id: BuiltinTools.Skill.id,
  name: BuiltinTools.Skill.name,
  description: SKILL_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  checkPermissions: async () => ({
    kind: 'tool',
    defaultDecision: 'allow',
    sessionApproval: 'tool',
  }),

  validateContext(ctx: ToolUseContext) {
    if (!ctx.skillPool) {
      return contextFail('Skill 工具仅在带技能池的 Turn 可用.');
    }
    return contextOk({ skillPool: ctx.skillPool });
  },

  async execute(input, context): Promise<SkillToolResult> {
    const entry = context.skillPool.getByPath(input.path);
    if (!entry) {
      const available = context.skillPool.entries.map(item => `${item.name}: ${item.path}`).join(', ') || '(空)';
      throw new Error(`Unknown skill path: ${input.path}. Available: ${available}`);
    }

    const instructions = await readFile(entry.path, 'utf8');

    return {
      name: entry.name,
      path: entry.path,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      description: entry.description,
      ...(entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {}),
      instructions,
    };
  },

  mapResultToModelContent(output) {
    const version = output.version === undefined ? '' : ` (v${output.version})`;
    return `Skill "${output.name}"${version} loaded. Resources root: ${dirname(output.path)}\n\n${output.instructions}`;
  },
});
