import { z } from 'zod';
import {
  buildTool,
  type BackgroundProcessOutput,
  type BackgroundProcess,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

interface ProcessOutputToolContext {
  backgroundProcesses: BackgroundProcess;
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
  ProcessOutputToolContext
>({
  id: BuiltinTools.ProcessOutput.id,
  name: BuiltinTools.ProcessOutput.name,
  description: `Read incremental stdout and stderr from one background process in the current Session.

Use nextCursor for continuation. waitMs may wait up to 30 seconds for new output; do not busy-poll.
After the process finishes, prefer reading the complete log file with the Read tool instead of paginating every line.`,
  inputSchema,
  maxResultBytes: 160_000,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({
    kind: 'tool',
    defaultDecision: 'allow',
    sessionApproval: 'tool',
  }),
  getToolUseSummary: (input) => `读取后台进程输出 ${input.backgroundProcessId}`,

  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力.');
    }
    return contextOk({ backgroundProcesses: ctx.backgroundProcesses });
  },

  async execute(
    input: ProcessOutputInput,
    context: ProcessOutputToolContext,
    invocation: ToolInvocation,
  ): Promise<ProcessOutputResult> {
    return context.backgroundProcesses.readOutput(
      invocation.sessionId,
      input.backgroundProcessId,
      { cursor: input.cursor, waitMs: input.waitMs },
    );
  },

  // 模型读取新增输出和下一页游标; 进程完整状态保留在结构化结果中供 UI 读取.
  mapResultToModelContent(output) {
    const sections: string[] = [];
    if (output.stdout) sections.push(`[stdout]\n${output.stdout}`);
    if (output.stderr) sections.push(`[stderr]\n${output.stderr}`);
    if (sections.length === 0) sections.push('该进程当前没有新增输出.');
    sections.push(
      output.hasMore
        ? `还有更多输出, 用 nextCursor=${output.nextCursor} 继续读取.`
        : '输出已到末尾.',
    );
    return sections.join('\n\n');
  },
});
