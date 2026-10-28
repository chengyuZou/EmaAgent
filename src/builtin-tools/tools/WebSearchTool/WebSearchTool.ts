import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { buildTool, contextOk, type ToolInvocation } from '@ema-agent/tools';
import { requestWeb } from '../WebFetchTool/network/webRequests.js';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { searchWeb, type SearchProgress, type SearchResult } from './adapters/index.js';
import { WEB_SEARCH_DESCRIPTION } from './prompt.js';

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

export type { SearchResult } from './adapters/index.js';

export interface WebSearchResult {
  query: string;
  results: SearchResult[];
}

export const WebSearchTool = buildTool<WebSearchInput, WebSearchResult, void, SearchProgress>({
  id: BuiltinTools.WebSearch.id,
  name: BuiltinTools.WebSearch.name,
  description: WEB_SEARCH_DESCRIPTION,
  maxResultBytes: 100_000,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  getToolUseSummary: (input) => input.query,

  async checkPermissions(input) {
    return {
      kind: 'webSearch',
      query: input.query,
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains,
    };
  },

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
    _context: void,
    invocation: ToolInvocation,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<WebSearchResult> {
    const query = input.query.trim();
    const results = await searchWeb(query, {
      request: requestWeb,
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
      + 'REMINDER: Cite only sources that actually support your answer using markdown hyperlinks. '
      + 'Search snippets help locate pages; use WebFetch when the underlying content needs verification.';
  },
});


function validateDomainEntry(domain: string): string | null {
  const value = domain.trim().toLowerCase();
  if (!value) return '域名条目不能为空';
  if (value.includes('/')) return `域名条目不能包含协议或路径: ${domain}`;
  if (value.includes('*')) return `域名条目不支持通配符: ${domain}`;
  if (/\s/.test(value)) return `域名条目不能包含空白: ${domain}`;
  if (/[^\p{L}\p{M}\p{N}.-]/u.test(value)) {
    return `无效域名: ${domain}`;
  }
  const ascii = domainToASCII(value);
  const validLabels = ascii.split('.').every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
  );
  if (!validLabels || ascii.length > 253) {
    return `无效域名: ${domain}`;
  }
  return null;
}
