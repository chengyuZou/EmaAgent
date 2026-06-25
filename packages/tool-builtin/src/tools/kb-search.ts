import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';
import type { KbSearchResult } from '@ema-agent/contracts';

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural-language search query for the knowledge base.'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of passages to return.'),
});

type KbSearchInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export type { KbSearchResult };

// ── Tool definition ───────────────────────────────────────────────────────────

export const kbSearchTool = buildTool<KbSearchInput, KbSearchResult>({
  name: 'kb_search',
  description: `Search the user's selected knowledge-base documents and return the most relevant passages with source attribution (file name, page, section).

Use this whenever the user's request might be answered by documents they have provided. The search is scoped to the documents the user selected for this turn — you only supply the query. Each returned hit includes a citation source so you can tell the user where the answer came from.`,

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

    return ctx.kbSearch(input.query, input.top_k);
  },
});
