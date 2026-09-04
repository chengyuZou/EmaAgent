// Skill 调用工具:从本根 Turn 冻结的 SkillPool 按绝对路径读取 SKILL.md,
// 返回完整指令与资源根。suggestedTools 是作者声明的建议工具,只供模型阅读,不做权限执行。
// 激活态不持久化——模型忘了技能内容就再调一次(目录常驻),这是 V1 拍板的简化。
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

/** Skill 工具的窄 Context:本 Turn 冻结技能池。 */
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
  version: string;
  description: string;
  whenToUse?: string;
  /** 作者声明的建议工具(frontmatter allowed-tools);仅供参考,不是权限规则。 */
  suggestedTools: string[];
  /** 技能目录绝对路径;scripts/references 由 FileRead/Bash 按需取用。 */
  /** SKILL.md 正文。 */
  instructions: string;
}

export const SkillTool = buildTool<SkillInput, SkillToolResult, SkillToolContext>({
  id: BuiltinTools.Skill.id,
  name: BuiltinTools.Skill.name,
  description: SKILL_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  // 技能只读执行(目录由根 Turn 冻结), 内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx: ToolUseContext) {
    // Pool 由根 Turn 装配;子 Agent 与 chat 态不注入,天然不可见。
    if (!ctx.skillPool) {
      return contextFail('Skill 工具仅在带技能池的根 Turn 可用。');
    }
    return contextOk({ skillPool: ctx.skillPool });
  },

  async execute(input, context): Promise<SkillToolResult> {
    const entry = context.skillPool.getByPath(input.path);
    if (!entry) {
      const available = context.skillPool.entries.map(item => `${item.name}: ${item.path}`).join(', ') || '(空)';
      throw new Error(`Unknown skill path: ${input.path}. Available: ${available}`);
    }

    const raw = await readFile(entry.path, 'utf8');
    const instructions = extractBody(raw);

    return {
      name: entry.name,
      path: entry.path,
      version: entry.version,
      description: entry.description,
      ...(entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {}),
      suggestedTools: [...entry.suggestedTools],
      instructions,
    };
  },

  mapResultToModelContent(output) {
    return `Skill "${output.name}" (v${output.version}) loaded. Resources root: ${dirname(output.path)}\n\n${output.instructions}`;
  },
});

/** SKILL.md 正文:剥掉 frontmatter,只渲染 body(frontmatter 是元数据不是指令)。 */
function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (match ? raw.slice(match[0].length) : raw).trim();
}
