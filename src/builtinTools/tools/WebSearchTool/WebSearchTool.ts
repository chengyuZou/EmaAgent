// 通过已配置的搜索服务返回有界的网页搜索结果; 后端选择、过滤与归一在 adapters 层。
import { z } from 'zod';
import { buildTool, contextOk, type ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { searchWeb, type SearchProgress } from './adapters/index.js';
import { WEB_SEARCH_DESCRIPTION } from './prompt.js';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('The search query to use.'),
  allowed_domains: z
    .array(z.string().min(1).max(253))
    .max(20)
    .optional()
    .describe('Only include results from these domains (exact or any subdomain).'),
  blocked_domains: z
    .array(z.string().min(1).max(253))
    .max(20)
    .optional()
    .describe('Never include results from these domains. Do not combine with allowed_domains.'),
}).strict();

type WebSearchInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  results: SearchResult[];
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const WebSearchTool = buildTool<WebSearchInput, WebSearchResult, undefined, SearchProgress>({
  id: BuiltinTools.WebSearch.id,
  name: BuiltinTools.WebSearch.name,
  description: WEB_SEARCH_DESCRIPTION,
  maxResultBytes: 100_000,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  getToolUseSummary: (input) => input.query,

  getPermissionIntent: () => ({
    riskLevel: 'medium',
    accessType: 'read',
    promptPolicy: 'whenRequired',
  }),

  // 本工具不消费宿主能力: 只依赖环境配置与 public-http, 无需窄 Context。
  validateContext() {
    return contextOk(undefined);
  },

  validateInput(input) {
    if (!input.query.trim()) {
      return { valid: false, message: 'query 不能为空' };
    }
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        valid: false,
        code: 'invalid_domain_filter',
        message: 'allowed_domains 与 blocked_domains 不能同时使用',
      };
    }
    for (const list of [input.allowed_domains, input.blocked_domains]) {
      for (const domain of list ?? []) {
        const issue = validateDomainEntry(domain);
        if (issue) {
          return { valid: false, code: 'invalid_domain_filter', message: issue };
        }
      }
    }
    return { valid: true };
  },

  async execute(
    input: WebSearchInput,
    _context: undefined,
    invocation: ToolInvocation,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<WebSearchResult> {
    const query = input.query.trim();
    const results = await searchWeb(query, {
      signal: invocation.signal,
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains,
      onProgress,
    });
    return { query, results };
  },

  mapResultToModelContent(output) {
    if (output.results.length === 0) {
      return `No search results found for "${output.query}".`;
    }
    const links = output.results
      .map((result) => {
        const line = `  - [${result.title}](${result.url})`;
        return result.snippet ? `${line}: ${result.snippet}` : line;
      })
      .join('\n');
    return `Web search results for query: "${output.query}"\n\nLinks:\n${links}\n\n`
      + 'REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';
  },
});

/** 域名条目形状校验: 拒绝空、协议/路径、通配符与空白, 规整交给适配层。 */
function validateDomainEntry(domain: string): string | null {
  const value = domain.trim().toLowerCase();
  if (!value) return '域名条目不能为空';
  if (value.includes('/')) return `域名条目不能包含协议或路径: ${domain}`;
  if (value.includes('*')) return `域名条目不支持通配符: ${domain}`;
  if (/\s/.test(value)) return `域名条目不能包含空白: ${domain}`;
  return null;
}
