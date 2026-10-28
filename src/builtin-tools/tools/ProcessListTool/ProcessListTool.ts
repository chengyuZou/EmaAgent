import { z } from 'zod';
import {
  buildTool,
  type BackgroundProcess,
  type BackgroundProcessStatus,
  type BackgroundProcessSummary,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

interface ProcessListToolContext {
  backgroundProcesses: BackgroundProcess;
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
  ProcessListToolContext
>({
  id: BuiltinTools.ProcessList.id,
  name: BuiltinTools.ProcessList.name,
  description: 'List background shell processes belonging to the current Session.',
  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // Session 身份由调用方提供, 查询不能指定其他 Session.
  checkPermissions: async () => ({
    kind: 'tool',
    defaultDecision: 'allow',
    sessionApproval: 'tool',
  }),
  getToolUseSummary: (input) => input.status
    ? `列出 ${input.status} 后台进程`
    : '列出后台进程',

  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力.');
    }
    return contextOk({ backgroundProcesses: ctx.backgroundProcesses });
  },

  async execute(
    input: ProcessListInput,
    context: ProcessListToolContext,
    invocation: ToolInvocation,
  ): Promise<ProcessListResult> {
    return {
      processes: context.backgroundProcesses.list(invocation.sessionId, {
        status: input.status as BackgroundProcessStatus | undefined,
        limit: input.limit,
      }),
    };
  },

  // 模型只需要进程列表; 日志目录等信息保留在结构化结果中供 UI 读取.
  mapResultToModelContent(output) {
    if (output.processes.length === 0) return '当前没有后台进程.';
    return output.processes.map((process) =>
      `- ${process.id} [${process.status}] ${process.command}`
      + (process.exitCode !== undefined ? ` (exit ${process.exitCode})` : ''),
    ).join('\n');
  },
});
