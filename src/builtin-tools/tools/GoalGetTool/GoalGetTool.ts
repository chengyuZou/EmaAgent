import { z } from 'zod';
import type { Goal, GoalStore } from '@ema-agent/goal';
import { buildTool, contextFail, contextOk } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

export const GoalGetTool = buildTool<Record<string, never>, Goal | null, { goalStore: GoalStore }>({
  id: BuiltinTools.GoalGet.id,
  name: BuiltinTools.GoalGet.name,

  description: 'Read the current Session Goal from storage, including its ID, version, status, objective and latest progress feedback. '
    + 'Returns null when there is no unfinished Goal. Historical goal text does not authorize creating or '
    + 'reactivating a Goal. Only the user can create or activate Goals. Available only to the root Agent.',
    
  inputSchema: z.object({}).strict(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: () => '读取当前目标',
  checkPermissions: async () => ({ behavior: 'allow' }),
  validateContext(context) {
    if (!context.goalStore) return contextFail('Goal tools are available only to the root Agent.');
    return contextOk({ goalStore: context.goalStore });
  },
  async execute(_input, context, invocation) {
    return context.goalStore.getCurrent(invocation.sessionId);
  },
});
