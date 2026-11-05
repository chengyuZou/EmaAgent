import { z } from 'zod';
import { buildTool, contextFail, contextOk, type ToolInvocation, type ToolUseContext } from '@ema-agent/tools';
import type { NarrativeTimelineId } from '@ema-agent/storage';
import type { NarrativeTimelineResult } from '@ema-agent/narrative';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { NARRATIVE_SEARCH_DESCRIPTION } from './prompt.js';

const MAX_QUERY_CHARS = 8_000;

const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_QUERY_CHARS)
    .describe('The user\'s story question, with known conversational references resolved when needed. Preserve its scope, uncertainty, and exclusions; do not add an answer or an extra question.'),
  mode: z
    .enum(['local', 'global', 'hybrid', 'naive', 'mix'])
    .optional()
    .describe('Retrieval strategy: local=entity-level facts, global=relationships/themes, hybrid=both (default), naive=plain vector without graph lookup, mix=knowledge graph + vector combined. Omit unless the question clearly demands a specific strategy.'),
}).strict();

type NarrativeSearchInput = z.infer<typeof inputSchema>;

type NarrativeSearchStatus = 'found' | 'partial' | 'empty' | 'unavailable';

export interface NarrativeSearchResult {
  readonly status: NarrativeSearchStatus;
  readonly timelines: readonly (NarrativeTimelineResult & { readonly timelineId: NarrativeTimelineId })[];
  readonly failures: readonly { readonly timelineId: NarrativeTimelineId; readonly message: string }[];
}

/** 只取得 Turn 提供的查询函数, 身份与取消走 ToolInvocation. */
interface NarrativeSearchToolContext {
  readonly narrativeSearch: NonNullable<ToolUseContext['narrativeSearch']>;
}

export const NarrativeSearchTool = buildTool<
  NarrativeSearchInput,
  NarrativeSearchResult,
  NarrativeSearchToolContext
>({
  id: BuiltinTools.NarrativeSearch.id,
  name: BuiltinTools.NarrativeSearch.name,
  description: NARRATIVE_SEARCH_DESCRIPTION,
  // 固定资产的图描述与原文一起交给模型. 超出本工具预算时仍由工具结果层外置保存.
  maxResultBytes: 512 * 1024,

  getToolUseSummary: (input) => `检索剧情资料:${input.query}`,
  inputSchema,
  isConcurrencySafe: () => true,

  // 只读剧情检索(按需启用), 内置信任放行.
  checkPermissions: async () => ({
    kind: 'tool',
    defaultDecision: 'allow',
    sessionApproval: 'tool',
  }),

  validateContext(ctx) {
    if (!ctx.narrativeSearch) {
      return contextFail('当前 Turn 未提供可用的 Narrative 查询能力.');
    }
    return contextOk({ narrativeSearch: ctx.narrativeSearch });
  },

  async execute(
    input: NarrativeSearchInput,
    context: NarrativeSearchToolContext,
    invocation: ToolInvocation,
  ): Promise<NarrativeSearchResult> {
    const recalled = await context.narrativeSearch(input.query, input.mode, invocation.signal);
    // Map 仅用于查询包内部. Tool 输出需经过消息保存和 WebSocket, 在此转换成 JSON 可表达的结果.
    const timelines: NarrativeSearchResult['timelines'][number][] = [];
    const failures: NarrativeSearchResult['failures'][number][] = [];
    for (const [timeline, result] of recalled) {
      if ('entities' in result) {
        timelines.push({ timelineId: timeline, ...result });
      } else {
        failures.push({ timelineId: timeline, message: result.message });
      }
    }
    const hasContent = timelines.some(
      timeline => timeline.entities.length > 0
        || timeline.relations.length > 0
        || timeline.chunks.length > 0,
    );
    let status: NarrativeSearchStatus;
    if (hasContent) {
      status = failures.length > 0 ? 'partial' : 'found';
    } else {
      status = failures.length > 0 ? 'unavailable' : 'empty';
    }

    return {
      status,
      timelines,
      failures,
    };
  },

  // 保存的结构化结果和模型读取的材料来自同一个对象, 不另维护一份正文字符串.
  // 紧凑 JSON 用于模型请求; 前端 CodeViewer 自行格式化显示.
  mapResultToModelContent(output) {
    return JSON.stringify(output);
  },
});
