import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import type {
  MemoryReadRequest,
  MemoryReadResponse,
  ReadMemory,
} from '@ema-agent/memory';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { MEMORY_READ_DESCRIPTION } from './prompt.js';

interface MemoryReadToolContext {
  readonly memoryRead: ReadMemory;
}

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to a formal memory file, relative to the memory root (e.g. work/MEMORY.md, topics/git.md).'),
  line_offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start reading from (default 1).'),
  max_lines: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of lines to return.'),
}).strict();

type MemoryReadInput = z.infer<typeof inputSchema>;

export type MemoryReadToolResult =
  | MemoryReadResponse
  | { readonly path: string; readonly notFound: true };

export const MemoryReadTool = buildTool<
  MemoryReadInput,
  MemoryReadToolResult,
  MemoryReadToolContext
>({
  id: BuiltinTools.MemoryRead.id,
  name: BuiltinTools.MemoryRead.name,
  description: MEMORY_READ_DESCRIPTION,

  inputSchema,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `读取记忆文件: ${input.path}`,
  // 只读已固化的正式记忆,内置信任放行.
  checkPermissions: async () => ({
    kind: 'tool',
    defaultDecision: 'allow',
    sessionApproval: 'tool',
  }),

  validateContext(ctx) {
    if (!ctx.memoryRead) {
      return contextFail('当前未装配记忆读取能力.');
    }
    return contextOk({ memoryRead: ctx.memoryRead });
  },

  async execute(
    input: MemoryReadInput,
    context: MemoryReadToolContext,
    invocation: ToolInvocation,
  ): Promise<MemoryReadToolResult> {
    const request: MemoryReadRequest = {
      path: input.path,
      lineOffset: input.line_offset,
      maxLines: input.max_lines,
      signal: invocation.signal,
    };
    const result = await context.memoryRead(request);
    if (result === undefined) {
      return { path: input.path, notFound: true };
    }
    return result;
  },

  // 模型需要文件正文本身;行号/截断等事实留在 TOutput 给 UI 与审计.
  mapResultToModelContent(output) {
    if ('notFound' in output) {
      return `记忆文件不存在: ${output.path}`;
    }
    return output.content;
  },
});
