// 分页读取当前 Session 后台进程的增量输出，可短暂等待新内容而不轮询 Agent。

import { z } from 'zod';
import {
  asBackgroundProcessId,
  type SessionId,
} from '@ema-agent/ids';
import {
  buildTool,
  type BackgroundProcessOutput,
  type BackgroundProcessPort,
  type BuiltinToolContext,
  contextFail,
  contextOk,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

interface ProcessOutputToolContext {
  backgroundProcesses: BackgroundProcessPort;
  sessionId: SessionId;
}

const inputSchema = z.object({
  backgroundProcessId: z.string().uuid(),
  cursor: z.string().optional(),
  waitMs: z.number().int().min(0).max(30_000).default(0),
}).strict();

type ProcessOutputInput = z.infer<typeof inputSchema>;
export type ProcessOutputResult = BackgroundProcessOutput;

export const ProcessOutputTool = buildTool<
  ProcessOutputInput,
  ProcessOutputResult,
  BuiltinToolContext,
  ProcessOutputToolContext
>({
  id: BuiltinTools.ProcessOutput.id,
  name: BuiltinTools.ProcessOutput.name,
  description: `Read incremental stdout and stderr from one background process in the current Session.

Use nextCursor for continuation. waitMs may wait up to 30 seconds for new output; do not busy-poll.`,
  inputSchema,
  maxResultBytes: 160_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),
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
  async execute(input, context): Promise<ProcessOutputResult> {
    return context.backgroundProcesses.readOutput(
      context.sessionId,
      asBackgroundProcessId(input.backgroundProcessId),
      { cursor: input.cursor, waitMs: input.waitMs },
    );
  },
});
