// 通过已配置的搜索服务返回有界的网页搜索结果。
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolInvocationContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { fetchBounded } from '../shared/BoundedFetch.js';

const SEARCH_TIMEOUT_MS = 20_000;
const API_RESPONSE_LIMIT = 5 * 1024 * 1024;
const HTML_RESPONSE_LIMIT = 2 * 1024 * 1024;

const braveResponseSchema = z.object({
  web: z.object({
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      description: z.string().optional().default(''),
    })).optional().default([]),
  }).optional(),
});

const bingResponseSchema = z.object({
  webPages: z.object({
    value: z.array(z.object({
      name: z.string(),
      url: z.string(),
      snippet: z.string().optional().default(''),
    })).optional().default([]),
  }).optional(),
});

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  query: z.string().min(1).describe('Search query.'),
  num_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Number of results to return.'),
});

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

export const WebSearchTool = buildTool<WebSearchInput, WebSearchResult>({
  id: BuiltinTools.WebSearch.id,
  name: BuiltinTools.WebSearch.name,
  description: `Search the web and return a list of relevant results (title, URL, snippet).

Adapter priority (uses the first configured one):
1. Brave Search API (\`BRAVE_SEARCH_API_KEY\` env var)
2. Bing Search API (\`BING_SEARCH_API_KEY\` env var)
3. DuckDuckGo HTML scraping (no API key required, rate-limited)`,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input: WebSearchInput, ctx: ToolInvocationContext): Promise<WebSearchResult> {
    const { query, num_results } = input;
    const results = await search(query, num_results, ctx.signal);
    return { query, results };
  },
});

// ── adapter ───────────────────────────────────────────────────────────────────

async function search(
  query: string,
  numResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  if (process.env['BRAVE_SEARCH_API_KEY']) {
    return braveSearch(query, numResults, process.env['BRAVE_SEARCH_API_KEY'], signal);
  }
  if (process.env['BING_SEARCH_API_KEY']) {
    return bingSearch(query, numResults, process.env['BING_SEARCH_API_KEY'], signal);
  }
  return duckduckgoSearch(query, numResults, signal);
}

async function braveSearch(
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetchBounded(url, {
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: API_RESPONSE_LIMIT,
    init: {
      redirect: 'error',
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    },
  });
  if (!res.ok) throw new Error(`Brave Search API error: ${res.status}`);
  const data = braveResponseSchema.parse(parseJson(res.body));
  return normalizeResults((data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  })), count);
}

async function bingSearch(
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetchBounded(url, {
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: API_RESPONSE_LIMIT,
    init: {
      redirect: 'error',
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    },
  });
  if (!res.ok) throw new Error(`Bing Search API error: ${res.status}`);
  const data = bingResponseSchema.parse(parseJson(res.body));
  return normalizeResults((data.webPages?.value ?? []).map((r) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
  })), count);
}

async function duckduckgoSearch(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // DuckDuckGo HTML 端点 - 基础爬取,无官方 API
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchBounded(url, {
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: HTML_RESPONSE_LIMIT,
    init: {
      redirect: 'error',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmaAgent/1.0)' },
    },
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  const html = res.body.toString('utf8');

  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];

  for (let i = 0; i < Math.min(links.length, count); i++) {
    const url = decodeDuckDuckGoUrl(links[i]![1]!);
    const title = links[i]![2]!.replace(/<[^>]+>/g, '').trim();
    const snippet = snippets[i]?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
    if (url && title) results.push({ title, url, snippet });
  }

  return normalizeResults(results, count);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('Search provider returned invalid JSON');
  }
}

function normalizeResults(results: readonly SearchResult[], limit: number): SearchResult[] {
  const normalized: SearchResult[] = [];
  for (const result of results) {
    if (normalized.length >= limit) break;
    const url = normalizePublicResultUrl(result.url);
    if (!url) continue;
    normalized.push({
      title: String(result.title ?? '').slice(0, 500),
      url,
      snippet: String(result.snippet ?? '').slice(0, 4_000),
    });
  }
  return normalized;
}

function normalizePublicResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function decodeDuckDuckGoUrl(value: string): string {
  const stripped = value.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '');
  try {
    return decodeURIComponent(stripped);
  } catch {
    return '';
  }
}
