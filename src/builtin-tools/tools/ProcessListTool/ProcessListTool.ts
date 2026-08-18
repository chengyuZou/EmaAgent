// 列出当前 Session 的后台 Shell，模型不能枚举其他 Session 的进程。
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

/** Process 工具族的窄 Context：只取后台进程端口; Session 身份走 ToolInvocation。 */
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
  // 只读查询本 Session 后台进程, 内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),
  getToolUseSummary: (input) => input.status
    ? `列出 ${input.status} 后台进程`
    : '列出后台进程',

  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力。');
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

  // 模型只需要紧凑列表; outputDir 等前端事实留在 TOutput。
  mapResultToModelContent(output) {
    if (output.processes.length === 0) return '当前没有后台进程。';
    return output.processes.map((process) =>
      `- ${process.id} [${process.status}] ${process.command}`
      + (process.exitCode !== undefined ? ` (exit ${process.exitCode})` : ''),
    ).join('\n');
  },
});
