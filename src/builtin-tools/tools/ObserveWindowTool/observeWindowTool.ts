import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ComputerObservation } from '@ema-agent/computer-use';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { computerContext, computerToolError, type ComputerToolContext } from '../shared/computerUse.js';
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
    return {
      kind: 'computerUse',
      needsStartupApproval: context.computer.needsStartupPermission,
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
