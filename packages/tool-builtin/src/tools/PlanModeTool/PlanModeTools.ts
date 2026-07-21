// 这里保留 V1.5 PlanMode 状态机的工具接口草稿，V1 禁止注册。
/**
 * ⚠ 暂未完成，等待 V1.5 更新。
 *
 * 当前文件只保留未来 PlanModeController 的接口草稿，尚未实现用户审批、
 * 动态工具裁剪、Permission Engine 策略切换和持久状态机。禁止把这里的
 * PlanEnter / PlanExit 注册给模型，否则会制造"已进入安全计划模式"的
 * 错误预期，而写文件、Shell 等工具实际上仍可继续执行。
 *
 * V1 的 Agent 只输出普通文字计划；完成真正的状态机前不要导出或注册本文件。
 */

import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { EmaStreamEvent } from '@ema-agent/turn';

// ── 共享输出类型 ──────────────────────────────────────────────────────────────

export interface PlanModeResult {
  active: boolean;
}

// ── PlanEnter ─────────────────────────────────────────────────────────────────

const enterSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe(
      'The plan to present to the user. Markdown is supported. ' +
        'Do not begin execution until the user approves.',
    ),
});

type PlanEnterInput = z.infer<typeof enterSchema>;

export const PlanEnterTool = buildTool<PlanEnterInput, PlanModeResult>({
  id: BuiltinTools.PlanEnter.id,
  name: BuiltinTools.PlanEnter.name,
  description: `Switch the agent into Plan Mode - present the proposed plan to the user and await their approval before executing any actions.

Use this when the task is non-trivial and the user has not explicitly said "just do it". The plan is shown as a structured UI card. The agent MUST NOT take any file-system or tool actions until the user approves or redirects.`,

  inputSchema: enterSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input: PlanEnterInput, ctx: ToolExecutionContext): Promise<PlanModeResult> {
    ctx.emit?.({
      type: 'system_warning',
      level: 'info',
      message: `PLAN:\n${input.plan}`,
    } satisfies EmaStreamEvent);
    return { active: true };
  },
});

// ── PlanExit ──────────────────────────────────────────────────────────────────

const exitSchema = z.object({
  result: z
    .string()
    .optional()
    .describe('Optional summary of what was accomplished after the plan completed.'),
});

type PlanExitInput = z.infer<typeof exitSchema>;

export const PlanExitTool = buildTool<PlanExitInput, PlanModeResult>({
  id: BuiltinTools.PlanExit.id,
  name: BuiltinTools.PlanExit.name,
  description: `Exit Plan Mode after the plan has been approved and execution is complete (or the user cancelled).`,

  inputSchema: exitSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input: PlanExitInput, ctx: ToolExecutionContext): Promise<PlanModeResult> {
    if (input.result) {
      ctx.emit?.({
        type: 'system_warning',
        level: 'info',
        message: `Plan completed: ${input.result}`,
      } satisfies EmaStreamEvent);
    }
    return { active: false };
  },
});
