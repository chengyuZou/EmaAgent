// 按需检索 Narrative 剧情资料，并把多时间线结果作为不可信工具资料返回模型。
import { z } from 'zod';
import { buildTool, contextFail, contextOk, type ToolInvocation, type ToolUseContext } from '@ema-agent/tools';
import type { NarrativeTimelineId } from '@ema-agent/storage';
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
  readonly timelines: readonly { readonly name: NarrativeTimelineId; readonly text: string }[];
  readonly failures: readonly { readonly timeline: NarrativeTimelineId; readonly message: string }[];
}

/** 只取得宿主提供的查询函数, 身份与取消走 ToolInvocation. */
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
  // 剧情正文以 CJK 为主, 按 UTF-8 最坏 3 字节/字符折算; 超限仍由结果层外置兜底。
  maxResultBytes: 300_000,

  getToolUseSummary: (input) => `检索剧情资料：${input.query}`,
  inputSchema,
  isReadOnly: () => true,
  // 查询会写关键词缓存. 工具调用顺序执行, 但不限制同一 Turn 的调用次数.
  isConcurrencySafe: () => false,

  // 只读剧情检索(按需启用), 内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx) {
    if (!ctx.narrativeSearch) {
      return contextFail('当前 Turn 未配置可用的 Narrative 模型绑定。');
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
      if ('text' in result) {
        timelines.push({ name: timeline, text: result.text });
      } else {
        failures.push({ timeline, message: result.message });
      }
    }
    const hasContent = timelines.some(
      (timeline) => timeline.text.trim().length > 0,
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

  // 模型需要正文本身; 状态/失败等事实留在 TOutput 给 UI 与审计。
  mapResultToModelContent(output) {
    const sections = output.timelines
      .filter((timeline) => timeline.text.trim().length > 0)
      .map((timeline) => `## ${timeline.name}\n${timeline.text.trim()}`);

    if (output.failures.length > 0) {
      sections.push(
        `检索失败的剧情线：${output.failures
          .map((failure) => `${failure.timeline} (${failure.message})`)
          .join(' ')}`,
      );
    }
    return sections.length > 0
      ? sections.join('\n\n')
      : 'Narrative 检索未返回可用剧情资料。';
  },
});
