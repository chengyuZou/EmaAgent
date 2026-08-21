// 跨两轨关键词搜索正式记忆，返回命中的路径、行号与片段。
// 能力从 ToolUseContext.memorySearch 取（根 Turn 装配注入，子 Agent 不注入）。
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolInvocation,
} from '@ema-agent/tools';
import type {
  MemorySearchRequest,
  MemorySearchResponse,
  SearchMemory,
} from '@ema-agent/memory';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { MEMORY_SEARCH_DESCRIPTION } from './prompt.js';

/** MemorySearch 工具的窄 Context：只取搜索端口；取消与调用身份走 ToolInvocation。 */
interface MemorySearchToolContext {
  readonly memorySearch: SearchMemory;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  queries: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(10)
    .describe('Keywords to search for (substring matching; case-sensitive by default).'),
  match_mode: z
    .enum(['any', 'all_on_same_line', 'all_within_lines'])
    .optional()
    .describe(
      'Matching mode: any - any keyword matches; ' +
        'all_on_same_line - all keywords on one line; ' +
        'all_within_lines - all keywords within a nearby line window.',
    ),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('Subdirectory to search within, relative to the memory root (e.g. work, relationship/characters/ema).'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Pagination cursor from the previous result's next_cursor."),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context before and after each match (default 0).'),
  case_sensitive: z
    .boolean()
    .optional()
    .describe('Case-sensitive matching (default true).'),
  normalized: z
    .boolean()
    .optional()
    .describe('Match after normalizing separators (default false).'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of matches to return (default 200).'),
}).strict();

type MemorySearchInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export type { MemorySearchResponse };

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const MemorySearchTool = buildTool<
  MemorySearchInput,
  MemorySearchResponse,
  MemorySearchToolContext
>({
  id: BuiltinTools.MemorySearch.id,
  name: BuiltinTools.MemorySearch.name,
  description: MEMORY_SEARCH_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `搜索记忆: ${input.queries.join(' ')}`,
  // 只读检索已固化的正式记忆，内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx) {
    if (!ctx.memorySearch) {
      return contextFail('当前未装配记忆检索能力。');
    }
    return contextOk({ memorySearch: ctx.memorySearch });
  },

  async execute(
    input: MemorySearchInput,
    context: MemorySearchToolContext,
    invocation: ToolInvocation,
  ): Promise<MemorySearchResponse> {
    const request: MemorySearchRequest = {
      queries: input.queries,
      matchMode: input.match_mode,
      path: input.path,
      cursor: input.cursor,
      contextLines: input.context_lines,
      caseSensitive: input.case_sensitive,
      normalized: input.normalized,
      maxResults: input.max_results,
      signal: invocation.signal,
    };
    return context.memorySearch(request);
  },

  // 模型需要命中片段本身；truncated/nextCursor 等事实留在 TOutput 给 UI 与审计。
  mapResultToModelContent(output) {
    if (output.matches.length === 0) {
      return `记忆中没有找到与 [${output.queries.join(', ')}] 相关的内容。`;
    }
    const lines = output.matches.map((match) => {
      const header = `${match.path}:${match.matchLineNumber}`;
      return match.contentStartLineNumber === match.matchLineNumber
        ? `[${header}] ${match.content}`
        : `[${header} (starts at line ${match.contentStartLineNumber})] ${match.content}`;
    });
    return (
      lines.join('\n') +
      (output.truncated ? '\n(结果已截断，可用 next_cursor 继续翻页。)' : '')
    );
  },
});
