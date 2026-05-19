import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';

// ── Input schema ──────────────────────────────────────────────────────────────

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

// ── Output type ───────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  results: SearchResult[];
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const webSearchTool = buildTool<WebSearchInput, WebSearchResult>({
  name: 'web_search',
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

  async execute(input: WebSearchInput, ctx: ToolExecutionContext): Promise<WebSearchResult> {
    const { query, num_results } = input;
    const results = await search(query, num_results, ctx.signal);
    return { query, results };
  },
});

// ── Adapters ──────────────────────────────────────────────────────────────────

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
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Brave Search API error: ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

async function bingSearch(
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Bing Search API error: ${res.status}`);
  const data = (await res.json()) as {
    webPages?: { value?: Array<{ name: string; url: string; snippet: string }> };
  };
  return (data.webPages?.value ?? []).map((r) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
  }));
}

async function duckduckgoSearch(
  query: string,
  _count: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // DuckDuckGo HTML endpoint — basic scraping, no official API
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmaAgent/1.0)' },
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];

  for (let i = 0; i < Math.min(links.length, _count); i++) {
    const url = decodeURIComponent(links[i]![1]!.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, ''));
    const title = links[i]![2]!.replace(/<[^>]+>/g, '').trim();
    const snippet = snippets[i]?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
    if (url && title) results.push({ title, url, snippet });
  }

  return results;
}
