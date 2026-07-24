// 在网络安全和响应大小边界内获取公开网页内容。
import { z } from 'zod';
import { isObviouslyUnsafePublicUrl } from '@ema-agent/public-http';
import { buildTool } from '@ema-agent/tools';
import type { ToolInvocationContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { fetchPublicPage } from './httpClient.js';
import { htmlToMarkdown } from './htmlToMarkdown.js';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_CHARS = 100_000;

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  url: z.string().url().describe('HTTP or HTTPS URL to fetch.'),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESPONSE_CHARS)
    .default(MAX_RESPONSE_CHARS)
    .describe('Maximum characters of response body to return.'),
  start_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Character offset to start reading from (for pagination).'),
  raw: z
    .boolean()
    .default(false)
    .describe('Return raw HTML instead of converting to Markdown.'),
});

type WebFetchInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface WebFetchResult {
  url: string;
  content: string;
  truncated: boolean;
  totalLength: number;
  durationMs: number;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const WebFetchTool = buildTool<WebFetchInput, WebFetchResult>({
  id: BuiltinTools.WebFetch.id,
  name: BuiltinTools.WebFetch.name,
  description: `Fetch a URL and return its content as Markdown (or raw HTML if raw: true).

- Localhost / private IP ranges are blocked.
- Follows up to 5 redirects.
- Times out after 30 seconds.
- Use \`start_index\` + \`max_length\` to paginate large pages.`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'medium',
    accessType: 'read',
    bypassImmune: true,
    safetyCheck: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return 'continue';
      return isObviouslyUnsafePublicUrl(parsed.data.url) ? 'deny' : 'continue';
    },
  },

  async execute(input: WebFetchInput, ctx: ToolInvocationContext): Promise<WebFetchResult> {
    const { url, max_length, start_index, raw } = input;

    const startMs  = Date.now();
    const response = await fetchPublicPage(url, ctx.signal);
    let content = raw ? response.body : htmlToMarkdown(response.body);

    const totalLength = content.length;
    const truncated   = start_index + max_length < totalLength;
    const sliced      = truncated
      ? content.slice(start_index, start_index + max_length) +
        `\n[Output truncated: ${totalLength.toLocaleString()} chars -> ${max_length.toLocaleString()} chars shown. Use start_index to paginate.]`
      : content.slice(start_index, start_index + max_length);

    return {
      url: response.finalUrl,
      content: sliced,
      truncated,
      totalLength,
      durationMs: Date.now() - startMs,
    };
  },
});
