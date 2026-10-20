import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { findContentRule, findMatchingContentRule } from '@ema-agent/permission';
import { buildTool, contextFail, contextOk, type ToolInvocation, type WebRequest } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { normalizeDomains, searchWeb, type SearchProgress, type SearchResult } from './adapters/index.js';
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

export const WebSearchTool = buildTool<WebSearchInput, WebSearchResult, WebRequest, SearchProgress>({
  id: BuiltinTools.WebSearch.id,
  name: BuiltinTools.WebSearch.name,
  description: WEB_SEARCH_DESCRIPTION,
  maxResultBytes: 100_000,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  getToolUseSummary: (input) => input.query,

  async checkPermissions(input, _context, permissionContext) {
    const ruleContent = webSearchRuleContent(input);
    const sessionAllowRule = { toolName: BuiltinTools.WebSearch.name, ruleContent };
    const denied = findContentRule(permissionContext, BuiltinTools.WebSearch.name, 'deny', ruleContent);
    if (denied) {
      return {
        behavior: 'deny',
        message: '已禁止本次 Web 搜索',
        decisionReason: { type: 'rule', rule: denied },
      };
    }
    const sessionRule = findMatchingContentRule(
      permissionContext, BuiltinTools.WebSearch.name, 'allow',
      content => content === ruleContent, 'session',
    );
    if (sessionRule) {
      return { behavior: 'allow', decisionReason: { type: 'rule', rule: sessionRule }, sessionAllowRule };
    }
    const asked = findContentRule(permissionContext, BuiltinTools.WebSearch.name, 'ask', ruleContent);
    if (asked) {
      return {
        behavior: 'ask',
        message: 'Web 搜索需要用户确认',
        decisionReason: { type: 'rule', rule: asked },
        sessionAllowRule,
      };
    }
    const allowed = findContentRule(permissionContext, BuiltinTools.WebSearch.name, 'allow', ruleContent);
    if (allowed) {
      return { behavior: 'allow', decisionReason: { type: 'rule', rule: allowed }, sessionAllowRule };
    }
    return { behavior: 'passthrough', message: 'Web 搜索需要用户确认', sessionAllowRule };
  },

  validateContext(context) {
    return context.webRequest
      ? contextOk(context.webRequest)
      : contextFail('Web requests are not configured by the host.');
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
    request: WebRequest,
    invocation: ToolInvocation,
    onProgress?: (progress: SearchProgress) => void,
  ): Promise<WebSearchResult> {
    const query = input.query.trim();
    const results = await searchWeb(query, {
      request,
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

function webSearchRuleContent(input: WebSearchInput): string {
  return `search:${JSON.stringify({
    query: input.query.trim(),
    allowed_domains: normalizeDomains(input.allowed_domains).sort(),
    blocked_domains: normalizeDomains(input.blocked_domains).sort(),
  })}`;
}

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
