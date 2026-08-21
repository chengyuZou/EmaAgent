// 列出记忆目录下的文件与子目录，支持分页。
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import type {
  ListMemory,
  MemoryListRequest,
  MemoryListResponse,
} from '@ema-agent/memory';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { MEMORY_LIST_DESCRIPTION } from './prompt.js';

/** MemoryList 工具的窄 Context：只取列举端口；取消与调用身份走 ToolInvocation。 */
interface MemoryListToolContext {
  readonly memoryList: ListMemory;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe('Directory to list, relative to the memory root. Omit to list the memory root (e.g. work, relationship/characters).'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Pagination cursor from the previous result's next_cursor."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe('Maximum number of entries to return (default 2000).'),
}).strict();

type MemoryListInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export type { MemoryListResponse };

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const MemoryListTool = buildTool<
  MemoryListInput,
  MemoryListResponse,
  MemoryListToolContext
>({
  id: BuiltinTools.MemoryList.id,
  name: BuiltinTools.MemoryList.name,
  description: MEMORY_LIST_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `列出记忆目录: ${input.path ?? '.'}`,
  // 只读列举已固化的正式记忆，内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx) {
    if (!ctx.memoryList) {
      return contextFail('当前未装配记忆目录能力。');
    }
    return contextOk({ memoryList: ctx.memoryList });
  },

  async execute(
    input: MemoryListInput,
    context: MemoryListToolContext,
    invocation: ToolInvocation,
  ): Promise<MemoryListResponse> {
    const request: MemoryListRequest = {
      path: input.path,
      cursor: input.cursor,
      maxResults: input.max_results,
      signal: invocation.signal,
    };
    return context.memoryList(request);
  },

  // 模型需要条目本身；truncated/nextCursor 等事实留在 TOutput 给 UI 与审计。
  mapResultToModelContent(output) {
    const where = output.path ?? '(记忆根)';
    if (output.entries.length === 0) {
      return `目录为空: ${where}`;
    }
    const lines = output.entries.map((entry) =>
      entry.entryType === 'directory' ? `${entry.path}/` : entry.path,
    );
    return (
      lines.join('\n') +
      (output.truncated ? '\n(结果已截断，可用 next_cursor 继续翻页。)' : '')
    );
  },
});
