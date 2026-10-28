import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { computerContext, computerPermission, computerToolError, type ComputerToolContext } from '../shared/computerUse.js';
import { COMPUTER_END_DESCRIPTION } from './prompt.js';

const inputSchema = z.object({}).strict();

export const ComputerEndTool = buildTool<z.infer<typeof inputSchema>, { ended: boolean }, ComputerToolContext>({
  id: BuiltinTools.ComputerEnd.id,
  name: BuiltinTools.ComputerEnd.name,
  description: COMPUTER_END_DESCRIPTION,
  inputSchema,
  isConcurrencySafe: () => false,
  validateContext: computerContext,
  checkPermissions: async () => computerPermission,
  async execute(_input, context, invocation) {
    try {
      return await context.computer.end(invocation.toolCallId, invocation.signal);
    } catch (error) {
      throw computerToolError(error);
    }
  },
});
