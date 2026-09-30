import { z } from 'zod';
import { GoalError, type Goal, type GoalStore } from '@ema-agent/goal';
import { buildTool, contextFail, contextOk } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

const inputSchema = z.object({
  goalId: z.uuid().describe('The existing Goal ID read from GoalGet or the current Goal instruction.'),
  expectedVersion: z.number().int().positive().describe('The latest Goal version returned by GoalGet or GoalUpdate. Stale versions are rejected.'),
  status: z.enum(['active', 'completed']).describe('Use active to report progress or completed to close the entire Goal.'),
  feedback: z.string().trim().min(1)
    .describe('Required for every update. Give a concise cumulative checkpoint; leave the full final result for the Turn response.'),
  reason: z.enum(['succeeded', 'failed']).optional()
    .describe('Required only for status=completed. Use failed only when the entire objective cannot be achieved.'),
  error: z.string().trim().min(1).optional()
    .describe('Required only for status=completed and reason=failed. Explain why the entire objective cannot be achieved.'),
}).strict().superRefine((input, context) => {
  if (input.status === 'active') {
    if (input.reason !== undefined || input.error !== undefined) {
      context.addIssue({ code: 'custom', message: 'active progress cannot include a completion reason or error' });
    }
    return;
  }
  if (input.reason === undefined) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'reason is required to complete a Goal' });
  }
  if (input.reason === 'failed' && input.error === undefined) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'error is required for final Goal failure' });
  }
  if (input.reason === 'succeeded' && input.error !== undefined) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'successful Goals cannot include an error' });
  }
});

export const GoalUpdateTool = buildTool<z.infer<typeof inputSchema>, Goal, { goalStore: GoalStore }>({
  id: BuiltinTools.GoalUpdate.id,
  name: BuiltinTools.GoalUpdate.name,
  description: 'Report progress on an existing active Goal using status=active and feedback. Feedback is a concise '
    + 'cumulative checkpoint, not the full final result; the final result belongs in the Turn response. It replaces '
    + 'the latest progress note; it cannot activate a paused or closed Goal. Report after meaningful '
    + 'work or before ending a work Turn with the objective unfinished, not after every loop. Use the returned '
    + 'version for subsequent updates. Report the Goal as completed only when its entire objective has actually been '
    + 'achieved, or finally failed with an error explanation. Completion also requires fresh feedback. '
    + 'Temporary difficulties, pending work, '
    + 'approvals and individual tool errors do not mean final Goal failure. Specify the exact Goal ID '
    + 'and expected version. Conflicts are errors: read GoalGet and reassess the latest objective, never '
    + 'blindly retry an old completion judgment with a new version. This tool cannot create, edit the objective, cancel, delete, '
    + 'pause or reactivate Goals. Completing a Goal does not abort the current Turn. Root Agent only.',
  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  getToolUseSummary: input => {
    if (input.status === 'active') return '报告目标进度';
    return input.reason === 'succeeded' ? '目标已完成' : '报告目标最终失败';
  },
  // 只报告用户已建立目标的进度或终态, 不扩大权限或重新开启持续工作.
  checkPermissions: async () => ({ behavior: 'allow' }),
  validateContext(context) {
    if (!context.goalStore) return contextFail('Goal tools are available only to the root Agent.');
    return contextOk({ goalStore: context.goalStore });
  },
  async execute(input, context, invocation) {
    const identity = {
      sessionId: invocation.sessionId,
      goalId: input.goalId,
      expectedVersion: input.expectedVersion,
    };
    try {
      if (input.status === 'active') {
        return context.goalStore.reportFeedback(identity, input.feedback);
      }
      if (input.reason === 'failed') {
        if (input.error === undefined) throw new Error('GoalUpdate requires error for failed completion.');
        return context.goalStore.fail(identity, input.feedback, input.error);
      }
      return context.goalStore.complete(identity, input.feedback);
    } catch (error) {
      if (!(error instanceof GoalError)) throw error;
      const goal = context.goalStore.get(invocation.sessionId, input.goalId);
      let instruction = 'Read GoalGet and reassess the latest objective. Do not blindly retry an old judgment with a new version.';
      if (!goal || goal.status === 'completed') {
        instruction = 'This Goal is closed or deleted. Stop pursuing its objective. Do not recreate or reactivate it.';
      } else if (goal.status === 'paused') {
        instruction = 'This Goal is paused. Stop pursuing its objective until the user explicitly activates it. Do not reactivate it yourself.';
      }
      // 工具执行层将抛错转换为 isError. 错误正文保留冲突身份和当前 SQL 事实.
      throw new Error(JSON.stringify({
        error: error.code,
        goal,
        currentGoal: context.goalStore.getCurrent(invocation.sessionId),
        instruction,
      }));
    }
  },
});
