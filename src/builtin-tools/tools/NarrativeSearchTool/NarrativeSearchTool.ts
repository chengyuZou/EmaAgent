// 按需检索 Narrative 剧情资料，并把多时间线结果作为不可信工具资料返回模型。
import { z } from 'zod';
import { buildTool, contextFail, contextOk, type ToolInvocation } from '@ema-agent/tools';
import type {
  NarrativeRecallTimeline,
  NarrativeSearch,
  NarrativeTimelineFailure,
} from '@ema-agent/narrative';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { NARRATIVE_SEARCH_DESCRIPTION } from './prompt.js';

const MAX_QUERY_CHARS = 8_000;

const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_QUERY_CHARS)
    .describe('A focused natural-language question about the story, characters, timeline, or world state.'),
  mode: z
    .enum(['local', 'global', 'hybrid', 'naive', 'mix'])
    .optional()
    .describe('Retrieval strategy: local=entity-level facts, global=relationships/themes, hybrid=both (default), naive=plain vector without keyword extraction, mix=knowledge graph + vector combined. Omit unless the question clearly demands a specific strategy.'),
}).strict();

type NarrativeSearchInput = z.infer<typeof inputSchema>;

type NarrativeSearchStatus = 'found' | 'partial' | 'empty' | 'unavailable';

export interface NarrativeSearchResult {
  readonly status: NarrativeSearchStatus;
  readonly timelines: readonly NarrativeRecallTimeline[];
  readonly failures: readonly NarrativeTimelineFailure[];
}

/** NarrativeSearch 工具的窄 Context：只取按需检索端口; 取消与身份走 ToolInvocation。 */
interface NarrativeSearchToolContext {
  readonly narrativeSearch: NarrativeSearch;
}

export const NarrativeSearchTool = buildTool<
  NarrativeSearchInput,
  NarrativeSearchResult,
  NarrativeSearchToolContext
>({
  id: BuiltinTools.NarrativeSearch.id,
  name: BuiltinTools.NarrativeSearch.name,
  description: NARRATIVE_SEARCH_DESCRIPTION,
  // 剧情正文以 CJK 为主, 按 UTF-8 最坏 3 字节/字符折算; 超限仍由结果层外置兜底。
  maxResultBytes: 300_000,

  getToolUseSummary: (input) => `检索剧情资料：${input.query}`,
  inputSchema,
  isReadOnly: () => true,
  // LightRAG 查询会更新内部缓存，同一 Turn 内保持顺序，避免多个查询争用缓存写入。
  isConcurrencySafe: () => false,

  // 只读剧情检索(按需启用), 内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx) {
    if (!ctx.narrativeSearch) {
      return contextFail('当前 Turn 未启用按需剧情检索。');
    }
    return contextOk({ narrativeSearch: ctx.narrativeSearch });
  },

  async execute(
    input: NarrativeSearchInput,
    context: NarrativeSearchToolContext,
    invocation: ToolInvocation,
  ): Promise<NarrativeSearchResult> {
    const recalled = await context.narrativeSearch(input.query, input.mode, invocation.signal);
    const hasContent = recalled.timelines.some(
      (timeline) => timeline.text.trim().length > 0,
    );
    const status: NarrativeSearchStatus = hasContent
      ? recalled.failures.length > 0 ? 'partial' : 'found'
      : recalled.failures.length > 0 ? 'unavailable' : 'empty';

    return {
      status,
      timelines: recalled.timelines,
      failures: recalled.failures,
    };
  },

  // 模型需要正文本身; 状态/失败等事实留在 TOutput 给 UI 与审计。
  mapResultToModelContent(output) {
    const sections = output.timelines
      .map((timeline) => timeline.text.trim())
      .filter((text) => text.length > 0)
      .map((text, index) => `## ${output.timelines[index]!.name}\n${text}`);

    if (output.failures.length > 0) {
      sections.push(
        `检索失败的剧情线：${output.failures
          .map((failure) => `${failure.timeline} (${failure.message})`)
          .join('')}`,
      );
    }
    return sections.length > 0
      ? sections.join('\n\n')
      : 'Narrative 检索未返回可用剧情资料。';
  },
});
