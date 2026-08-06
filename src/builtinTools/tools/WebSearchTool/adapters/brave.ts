// Brave 搜索 API 后端: 只取回原始结果, 过滤/归一/去重交给适配层统一处理。
import { z } from 'zod';
import { fetchPublicResource } from '@ema-agent/public-http';
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js';

const SEARCH_TIMEOUT_MS = 20_000;
const API_RESPONSE_LIMIT = 5 * 1024 * 1024;

const braveResponseSchema = z.object({
  web: z.object({
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      description: z.string().optional().default(''),
    })).optional().default([]),
  }).optional(),
});

const BRAVE_API_KEY_ENV_VARS = ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'] as const;

export const braveSearch: WebSearchAdapter = async (
  query: string,
  options: SearchOptions,
): Promise<SearchResult[]> => {
  const apiKey = getBraveApiKey();
  if (!apiKey) {
    throw new Error('缺少 BRAVE_SEARCH_API_KEY');
  }
  const url =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`;
  // 主机写死 + additionalAllowedHeaders 声明: API key 只流向 Brave, 不会被重定向带走。
  const res = await fetchPublicResource(url, {
    signal: options.signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: API_RESPONSE_LIMIT,
    maxRedirects: 0,
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    additionalAllowedHeaders: ['x-subscription-token'],
  });
  const data = braveResponseSchema.parse(parseJsonBody(res.body));
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
};

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('返回了无效 JSON');
  }
}

function getBraveApiKey(): string {
  for (const envVar of BRAVE_API_KEY_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }
  return '';
}
