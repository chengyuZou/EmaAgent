import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { KbSearchResult } from '@ema-agent/contracts';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural-language search query for the knowledge base.'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of passages to return.'),
  kb_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of knowledge-base IDs to search. ' +
      'Omit to search the KB the user selected for this turn (or the active KB as fallback). ' +
      'Provide multiple IDs to merge results across KBs by relevance score.',
    ),
});

type KbSearchInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export type { KbSearchResult };

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const kbSearchTool = buildTool<KbSearchInput, KbSearchResult>({
  name: 'kb_search',
  description: `Search the user's knowledge-base documents and return the most relevant passages with source attribution (file name, page, section).

Use this whenever the user's request might be answered by documents they have provided. The search is scoped to the documents the user selected for this turn - you only supply the query. Each returned hit includes a citation source so you can tell the user where the answer came from.

If the user has multiple knowledge bases, you may specify kb_ids to target one or more of them explicitly; omit kb_ids to search the KB selected for this turn.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input: KbSearchInput, ctx: ToolExecutionContext): Promise<KbSearchResult> {
    if (!ctx.kbSearch) {
      throw new Error(
        'Knowledge-base search is not available. No KB documents are selected for this turn.',
      );
    }

    return ctx.kbSearch(input.query, input.top_k, input.kb_ids);
  },
});
