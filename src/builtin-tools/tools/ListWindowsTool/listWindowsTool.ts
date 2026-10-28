import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ComputerWindow } from '@ema-agent/computer-use';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { computerContext, computerPermission, computerToolError, type ComputerToolContext } from '../shared/computerUse.js';
import { LIST_WINDOWS_DESCRIPTION } from './prompt.js';

const inputSchema = z.object({}).strict();

export const ListWindowsTool = buildTool<z.infer<typeof inputSchema>, ComputerWindow[], ComputerToolContext>({
  id: BuiltinTools.ListWindows.id,
  name: BuiltinTools.ListWindows.name,
  description: LIST_WINDOWS_DESCRIPTION,
  inputSchema,
  isConcurrencySafe: () => false,
  validateContext: computerContext,
  checkPermissions: async (_input, context) => {
    if (context.computer.state) return computerPermission;
    return { kind: 'tool', defaultDecision: 'allow', sessionApproval: 'tool' };
  },
  async execute(_input, context, invocation) {
    try {
      return await context.computer.listWindows(invocation.toolCallId, invocation.signal);
    } catch (error) {
      throw computerToolError(error);
    }
  },
});
