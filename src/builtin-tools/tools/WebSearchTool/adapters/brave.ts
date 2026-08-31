// Brave 搜索 API 后端: 只取回原始结果, 过滤/归一/去重交给适配层统一处理。
import { z } from 'zod';
import { SearchHttpStatusError } from './types.js';
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
  const res = await fetch(url, {
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
    redirect: 'manual',
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  });
  if (res.status !== 200) {
    throw new SearchHttpStatusError(res.status);
  }
  const body = await res.arrayBuffer();
  if (body.byteLength > API_RESPONSE_LIMIT) {
    throw new Error(`搜索响应体超过 ${API_RESPONSE_LIMIT} 字节上限`);
  }
  const data = braveResponseSchema.parse(parseJsonBody(Buffer.from(body)));
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
