// 分页读取当前 Session 后台进程的增量输出，可短暂等待新内容而不轮询 Agent。
import { z } from 'zod';
import {
  buildTool,
  type BackgroundProcessOutput,
  type BackgroundProcessPort,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** Process 工具族的窄 Context：只取后台进程端口; Session 身份走 ToolInvocation。 */
interface ProcessOutputToolContext {
  backgroundProcesses: BackgroundProcessPort;
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
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),
  getToolUseSummary: (input) => `读取后台进程输出 ${input.backgroundProcessId}`,

  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力。');
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

  // 模型只需要输出增量与续读提示; process 全量事实留在 TOutput 给 UI/审计。
  mapResultToModelContent(output) {
    const sections: string[] = [];
    if (output.stdout) sections.push(`[stdout]\n${output.stdout}`);
    if (output.stderr) sections.push(`[stderr]\n${output.stderr}`);
    if (sections.length === 0) sections.push('该进程当前没有新增输出。');
    sections.push(
      output.hasMore
        ? `还有更多输出, 用 nextCursor=${output.nextCursor} 继续读取。`
        : '输出已到末尾。',
    );
    return sections.join('\n\n');
  },
});
