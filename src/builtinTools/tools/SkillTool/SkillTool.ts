// Skill 调用工具:从本根 Turn 冻结的 SkillPool 取描述符,有界读全文、渲染参数、
// 按 allowed-tools 收窄能力(只收窄),返回完整指令与资源根。
// 激活态不持久化——模型忘了技能内容就再调一次(目录常驻),这是 V1 拍板的简化。
import { join } from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolUseContext,
} from '@ema-agent/tools';
import {
  readSkillFileBounded,
  type SkillPool,
} from '@ema-agent/skills';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { SKILL_DESCRIPTION } from './prompt.js';

/** Skill 工具的窄 Context:本 Turn 冻结技能池。 */
interface SkillToolContext {
  skillPool: SkillPool;
}

const inputSchema = z.object({
  skill: z.string().min(1).max(256).describe(
    'The skill call name exactly as shown in the available skills listing, e.g. "code-review".',
  ),
  args: z.string().max(10_000).optional().describe(
    'Optional free-text arguments; substituted for $ARGUMENTS in the skill body.',
  ),
}).strict();

type SkillInput = z.infer<typeof inputSchema>;

export interface SkillToolResult {
  callName: string;
  name: string;
  version: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  allowedToolPatterns: string[];
  /** 技能目录绝对路径;scripts/references 由 FileRead/Bash 按需取用。 */
  rootPath: string;
  /** 渲染参数后的 SKILL.md 全文。 */
  instructions: string;
}

export const SkillTool = buildTool<SkillInput, SkillToolResult, SkillToolContext>({
  id: BuiltinTools.Skill.id,
  name: BuiltinTools.Skill.name,
  description: SKILL_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,

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
    const callName = normalizeCallName(input.skill);
    const entry = context.skillPool.getByCallName(callName);
    if (!entry) {
      const available = context.skillPool.entries.map((item) => item.callName).join(', ') || '(空)';
      throw new Error(`Unknown skill: ${callName}. Available: ${available}`);
    }

    const raw = await readSkillFileBounded(join(entry.rootPath, 'SKILL.md'));
    const instructions = renderArguments(extractBody(raw), input.args);

    return {
      callName: entry.callName,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      ...(entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {}),
      ...(entry.argumentHint !== undefined ? { argumentHint: entry.argumentHint } : {}),
      allowedToolPatterns: [...entry.allowedToolPatterns],
      rootPath: entry.rootPath,
      instructions,
    };
  },

  mapResultToModelContent(output) {
    return `Skill "${output.callName}" (v${output.version}) loaded. Resources root: ${output.rootPath}\n\n${output.instructions}`;
  },
});

/** 去空白、剥前导斜杠(模型有时会写成 /name)。 */
function normalizeCallName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

/** SKILL.md 正文:剥掉 frontmatter,只渲染 body(frontmatter 是元数据不是指令)。 */
function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (match ? raw.slice(match[0].length) : raw).trim();
}

/**
 * $ARGUMENTS 全量替换;无占位符且给了 args 时追加到末尾。
 * 不做 `!command` 执行替换——那是注入面,不抄。
 */
function renderArguments(body: string, args: string | undefined): string {
  const value = args ?? '';
  if (body.includes('$ARGUMENTS')) return body.split('$ARGUMENTS').join(value);
  return value ? `${body}\n\n${value}` : body;
}
