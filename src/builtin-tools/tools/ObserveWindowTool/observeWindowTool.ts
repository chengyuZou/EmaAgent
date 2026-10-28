import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ComputerObservation } from '@ema-agent/computer-use';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { computerContext, computerPermission, computerToolError, type ComputerToolContext } from '../shared/computerUse.js';
import { OBSERVE_WINDOW_DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  windowId: z.string().min(1).describe('Window id returned by ListWindows.'),
}).strict();

export const ObserveWindowTool = buildTool<z.infer<typeof inputSchema>, ComputerObservation, ComputerToolContext>({
  id: BuiltinTools.ObserveWindow.id,
  name: BuiltinTools.ObserveWindow.name,
  description: OBSERVE_WINDOW_DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  getToolUseSummary: input => `观察窗口 ${input.windowId}`,
  validateContext: computerContext,
  async validateInput(_input, context, invocation) {
    try {
      context.computer.reserve(invocation.toolCallId);
      return { valid: true };
    } catch (error) {
      const failure = computerToolError(error);
      return { valid: false, message: failure.message, code: failure.code };
    }
  },
  async checkPermissions(_input, context) {
    if (!context.computer.needsStartupPermission) return computerPermission;
    return {
      behavior: 'ask',
      message: '允许 Ema 启动电脑控制吗? 控制期间可观察窗口并执行键鼠操作. 用户输入会暂停, Ctrl+Alt+C 继续, Esc 结束控制.',
      // 启动许可只属于这次启动调用, 结束后不能用旧批准放行另一段控制.
      sessionAllowRule: { toolName: BuiltinTools.ObserveWindow.name, ruleContent: `control:${context.computer.state!.controlId}` },
    };
  },
  async execute(input, context, invocation) {
    try {
      return await context.computer.observe(invocation.toolCallId, input.windowId, invocation.signal);
    } catch (error) {
      throw computerToolError(error);
    }
  },
  mapResultToModelContent(output) {
    const { image, ...description } = output;
    return [
      { type: 'text', text: JSON.stringify(description) },
      { type: 'image_data', data: image, mimeType: output.mimeType },
    ];
  },
});
