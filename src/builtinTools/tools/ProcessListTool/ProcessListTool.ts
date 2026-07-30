// 列出当前 Session 的后台 Shell，模型不能枚举其他 Session 的进程。

import { z } from 'zod';
import type { SessionId } from '@ema-agent/ids';
import {
  buildTool,
  type BackgroundProcessPort,
  type BackgroundProcessStatus,
  type BackgroundProcessSummary,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';

interface ProcessListToolContext {
  backgroundProcesses: BackgroundProcessPort;
  sessionId: SessionId;
}

const statusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'timedOut',
  'stopped',
  'interrupted',
]);

const inputSchema = z.object({
  status: statusSchema.optional().describe('Optional status filter.'),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

type ProcessListInput = z.infer<typeof inputSchema>;

export interface ProcessListResult {
  processes: BackgroundProcessSummary[];
}

export const ProcessListTool = buildTool<
  ProcessListInput,
  ProcessListResult,
  BuiltinToolContext,
  ProcessListToolContext
>({
  id: BuiltinTools.ProcessList.id,
  name: BuiltinTools.ProcessList.name,
  description: 'List background shell processes belonging to the current Session.',
  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionMeta: { riskLevel: 'low', accessType: 'read' },
  requires: ['backgroundProcesses'],
  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力。');
    }
    return contextOk({
      backgroundProcesses: ctx.backgroundProcesses,
      sessionId: ctx.sessionId,
    });
  },
  async execute(input, context): Promise<ProcessListResult> {
    return {
      processes: context.backgroundProcesses.list(context.sessionId, {
        status: input.status as BackgroundProcessStatus | undefined,
        limit: input.limit,
      }),
    };
  },
});
