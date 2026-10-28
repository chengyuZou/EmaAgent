import { z } from 'zod';
import {
  buildTool,
  type BackgroundProcess,
  type BackgroundProcessSummary,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

interface ProcessStopToolContext {
  backgroundProcesses: BackgroundProcess;
}

const inputSchema = z.object({
  backgroundProcessId: z.string().uuid(),
}).strict();

type ProcessStopInput = z.infer<typeof inputSchema>;
export type ProcessStopResult = BackgroundProcessSummary;

export const ProcessStopTool = buildTool<
  ProcessStopInput,
  ProcessStopResult,
  ProcessStopToolContext
>({
  id: BuiltinTools.ProcessStop.id,
  name: BuiltinTools.ProcessStop.name,
  description: 'Stop one queued or running background process in the current Session.',
  getToolUseSummary: (input) => `Stop background process ${input.backgroundProcessId}`,
  inputSchema,
  maxResultBytes: 50_000,
  isConcurrencySafe: () => false,
  // 终止后台进程有副作用, 交给工具权限规则和模式决定是否询问.
  checkPermissions: async () => ({
    kind: 'tool',
    defaultDecision: 'ask',
    message: '停止后台进程需要用户确认',
    sessionApproval: 'input',
  }),

  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力.');
    }
    return contextOk({ backgroundProcesses: ctx.backgroundProcesses });
  },

  async execute(
    input: ProcessStopInput,
    context: ProcessStopToolContext,
    invocation: ToolInvocation,
  ): Promise<ProcessStopResult> {
    return context.backgroundProcesses.stop(
      invocation.sessionId,
      input.backgroundProcessId,
    );
  },

  // 结果中的状态来自后台进程记录, 不把已提交停止请求直接当作停止成功.
  mapResultToModelContent(output) {
    return `后台进程 ${output.command} 最终状态: ${output.status}`
      + (output.exitCode !== undefined ? ` (exit ${output.exitCode})` : '');
  },
});
