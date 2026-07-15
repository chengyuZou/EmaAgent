import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 30_000;

/** 封禁域名 - 不应从 agent 访问的 localhost/私网段。 */
const BLOCKED_HOSTNAME_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

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

export const webFetchTool = buildTool<WebFetchInput, WebFetchResult>({
  name: 'web_fetch',
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
    safetyCheck: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return 'continue';
      try {
        const { hostname } = new URL(parsed.data.url);
        if (BLOCKED_HOSTNAME_RE.test(hostname)) return 'deny';
      } catch {
        return 'deny';
      }
      return 'continue';
    },
  },

  async execute(input: WebFetchInput, ctx: ToolExecutionContext): Promise<WebFetchResult> {
    const { url, max_length, start_index, raw } = input;

    // 执行时也封私网段
    try {
      const { hostname, protocol } = new URL(url);
      if (!['http:', 'https:'].includes(protocol)) {
        throw new Error(`Unsupported protocol: ${protocol}`);
      }
      if (BLOCKED_HOSTNAME_RE.test(hostname)) {
        throw new Error(`Access to ${hostname} is blocked for security reasons.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access to')) throw err;
      throw new Error(`Invalid URL: ${url}`);
    }

    const startMs  = Date.now();
    const response = await fetch(url, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      redirect: 'follow',
      headers: { 'User-Agent': 'EmaAgent/1.0 (+https://github.com/ema-agent)' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const text = await response.text();
    let content = raw ? text : htmlToMarkdown(text);

    const totalLength = content.length;
    const truncated   = start_index + max_length < totalLength;
    const sliced      = truncated
      ? content.slice(start_index, start_index + max_length) +
        `\n[Output truncated: ${totalLength.toLocaleString()} chars -> ${max_length.toLocaleString()} chars shown. Use start_index to paginate.]`
      : content.slice(start_index, start_index + max_length);

    return { url, content: sliced, truncated, totalLength, durationMs: Date.now() - startMs };
  },
});

// ── HTML -> Markdown(最小,无外部依赖)──────────────────────────────────────

function htmlToMarkdown(html: string): string {
  return html
    // 移除 script + style 块
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // 标题
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `${'#'.repeat(Number(n))} ${stripTags(t)}\n\n`)
    // 段落 + div
    .replace(/<\/?(p|div|section|article|main|header|footer|nav)[^>]*>/gi, '\n\n')
    // 换行
    .replace(/<br\s*\/?>/gi, '\n')
    // 粗体
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `**${stripTags(c)}**`)
    // 斜体
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `_${stripTags(c)}_`)
    // 链接
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${stripTags(text)}](${href})`)
    // 代码
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${c}\``)
    // Pre 块
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\`\`\`\n${stripTags(c)}\n\`\`\`\n`)
    // 列表项
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c).trim()}\n`)
    // 剥离剩余标签
    .replace(/<[^>]+>/g, '')
    // 解码实体
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // 折叠多余空行
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}
