import { z } from 'zod';
import { computerActionSchema, type ComputerActionResult } from '@ema-agent/computer-use';
import { buildTool, ToolExecutionError } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { computerContext, computerPermission, computerToolError, type ComputerToolContext } from '../shared/computerUse.js';
import { COMPUTER_ACTION_DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  observationId: z.string().min(1),
  action: computerActionSchema,
}).strict();

export const ComputerActionTool = buildTool<z.infer<typeof inputSchema>, ComputerActionResult, ComputerToolContext>({
  id: BuiltinTools.ComputerAction.id,
  name: BuiltinTools.ComputerAction.name,
  description: COMPUTER_ACTION_DESCRIPTION,
  inputSchema,
  isConcurrencySafe: () => false,
  getToolUseSummary: input => `电脑操作: ${input.action.type}`,
  validateContext: computerContext,
  checkPermissions: async () => computerPermission,
  async execute(input, context, invocation) {
    try {
      const result = await context.computer.act(invocation.toolCallId, input.observationId, input.action, invocation.signal);
      if (result.status !== 'completed') {
        let code = `computer/${result.status}`;
        if (result.effect === 'possible') code = 'tool/outcome_unknown';
        throw new ToolExecutionError(result, result.message, code);
      }
      return result;
    } catch (error) {
      throw computerToolError(error);
    }
  },
});
