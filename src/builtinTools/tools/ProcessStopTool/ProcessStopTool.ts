// 终止当前 Session 的一个后台进程，实际停止仍由 Sandbox 杀整棵进程树。

import { z } from 'zod';
import {
  asBackgroundProcessId,
  type SessionId,
} from '@ema-agent/ids';
import {
  buildTool,
  type BackgroundProcessPort,
  type BackgroundProcessSummary,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';

interface ProcessStopToolContext {
  backgroundProcesses: BackgroundProcessPort;
  sessionId: SessionId;
}

const inputSchema = z.object({
  backgroundProcessId: z.string().uuid(),
}).strict();

type ProcessStopInput = z.infer<typeof inputSchema>;
export type ProcessStopResult = BackgroundProcessSummary;

export const ProcessStopTool = buildTool<
  ProcessStopInput,
  ProcessStopResult,
  BuiltinToolContext,
  ProcessStopToolContext
>({
  id: BuiltinTools.ProcessStop.id,
  name: BuiltinTools.ProcessStop.name,
  description: 'Stop one queued or running background process in the current Session.',
  getToolUseSummary: input => `Stop background process ${input.backgroundProcessId}`,
  inputSchema,
  maxResultBytes: 50_000,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
  },
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
  async execute(input, context): Promise<ProcessStopResult> {
    return context.backgroundProcesses.stop(
      context.sessionId,
      asBackgroundProcessId(input.backgroundProcessId),
    );
  },
});
