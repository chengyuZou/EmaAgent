import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// Stub: plan_enter / plan_exit are text-only signals to the frontend.
// No permission gating, no tool blocking, no approval state machine.
// Full PlanModeController (strips dangerous permissions, approval gate,
// circuit breaker) is deferred to V1.5. See CLAUDE.md §6 for design.

// ── Shared output type ────────────────────────────────────────────────────────

export interface PlanModeResult {
  active: boolean;
}

// ── plan_enter ────────────────────────────────────────────────────────────────

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

export const planEnterTool = buildTool<PlanEnterInput, PlanModeResult>({
  name: 'plan_enter',
  description: `Switch the agent into Plan Mode — present the proposed plan to the user and await their approval before executing any actions.

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

// ── plan_exit ─────────────────────────────────────────────────────────────────

const exitSchema = z.object({
  result: z
    .string()
    .optional()
    .describe('Optional summary of what was accomplished after the plan completed.'),
});

type PlanExitInput = z.infer<typeof exitSchema>;

export const planExitTool = buildTool<PlanExitInput, PlanModeResult>({
  name: 'plan_exit',
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
