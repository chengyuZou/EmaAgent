// 加载指定 Skill 的指令，并通过 Skill Runner 注入当前 Agent。
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type BuiltinToolContext,
  ToolCapabilityScope,
} from '@ema-agent/tools';
import type {
  ActiveSkillStatePort,
  ActivatedSkill,
  SkillRunnerPort,
} from '@ema-agent/skills';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** SkillCall 工具的窄 Context：Skill 运行器 + 工具能力边界。 */
interface SkillCallToolContext {
  skillRunner: SkillRunnerPort;
  activeSkillState: ActiveSkillStatePort;
  toolCapabilities: ToolCapabilityScope;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  skill: z.string().trim().min(1).max(128).describe(
    'Skill name from the available skill catalog, without a leading slash.',
  ),
  args: z.string().optional().describe('Optional arguments string passed to the skill.'),
});

type SkillCallInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface SkillCallResult {
  skill: string;
  /** 当前 Skill 的 SKILL.md 绝对路径。 */
  path: string;
  rootPath: string;
  bundleRevision: string;
  output: string;
  /** 多文件 Bundle 的可读取路径；正文仍由 FileRead/Bash 按需处理。 */
  files: readonly {
    path: string;
    relativePath: string;
    kind: ActivatedSkill['files'][number]['kind'];
  }[];
  /** Skill 限制生效后，下一次模型调用实际可见的工具名称。 */
  availableTools?: readonly string[];
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const SkillCallTool = buildTool<SkillCallInput, SkillCallResult, BuiltinToolContext, SkillCallToolContext>({
  id: BuiltinTools.SkillCall.id,
  name: BuiltinTools.SkillCall.name,
  description: `Load a named Skill into the current Agent context.

The result contains the Skill instructions for the current workflow. A Skill does not execute its steps atomically and does not bypass Tool permission or sandbox checks. If the Skill declares allowed tools, it can only narrow the current Agent's tool set.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  getPermissionIntent: () => ({
    riskLevel: 'medium',
    accessType: 'execute',
    promptPolicy: 'whenRequired',
  }),

  // toolCapabilities 由本轮 Manifest 派生，外部装配只需证明 SkillRunner 存在。
  requires: ['skillRunner', 'activeSkillState'],

  validateContext(ctx) {
    if (!ctx.skillRunner || !ctx.activeSkillState || !ctx.toolCapabilities) {
      return contextFail('当前没有 Skill 执行能力。');
    }
    return contextOk({
      skillRunner: ctx.skillRunner,
      activeSkillState: ctx.activeSkillState,
      toolCapabilities: ctx.toolCapabilities,
    });
  },

  async execute(input: SkillCallInput, context: SkillCallToolContext): Promise<SkillCallResult> {
    const activation = await context.skillRunner.run(input.skill, input.args);
    if (activation.allowedToolPatterns.length === 0) {
      context.activeSkillState.activate(activation);
      return toSkillCallResult(activation);
    }

    const snapshot = context.toolCapabilities.restrict({
      source: `skill:${input.skill}`,
      allowedToolPatterns: activation.allowedToolPatterns,
    });
    // 能力收窄失败时不能留下一个看似已成功的激活状态。
    context.activeSkillState.activate(activation);
    return {
      ...toSkillCallResult(activation),
      availableTools: snapshot.allowedToolNames,
    };
  },
});

function toSkillCallResult(activation: ActivatedSkill): SkillCallResult {
  return {
    skill: activation.name,
    path: activation.path,
    rootPath: activation.rootPath,
    bundleRevision: activation.bundleRevision,
    output: activation.instructions,
    files: activation.files.map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      kind: file.kind,
    })),
  };
}
