// 终止当前 Session 的一个后台进程，实际停止仍由 Sandbox 杀整棵进程树。
import { z } from 'zod';
import { asBackgroundProcessId } from '@ema-agent/ids';
import {
  buildTool,
  type BackgroundProcessPort,
  type BackgroundProcessSummary,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** Process 工具族的窄 Context：只取后台进程端口; Session 身份走 ToolInvocation。 */
interface ProcessStopToolContext {
  backgroundProcesses: BackgroundProcessPort;
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
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  getPermissionIntent: () => ({
    riskLevel: 'high',
    accessType: 'execute',
    promptPolicy: 'whenRequired',
  }),

  validateContext(ctx) {
    if (!ctx.backgroundProcesses) {
      return contextFail('当前执行环境没有后台进程能力。');
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
      asBackgroundProcessId(input.backgroundProcessId),
    );
  },

  // 停止请求返回真实终态快照, 投影只给模型确认信息。
  mapResultToModelContent(output) {
    return `后台进程 ${output.command} 最终状态: ${output.status}`
      + (output.exitCode !== undefined ? ` (exit ${output.exitCode})` : '');
  },
});
