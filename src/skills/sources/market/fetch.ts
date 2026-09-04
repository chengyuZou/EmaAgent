// 市场上游 HTTP 边界的公共行为:10s 超时、429/5xx 重试一次、限长读、来源健康记账。
import { recordSourceFailure, recordSourceSuccess } from './cache.js';
import {
  MARKET_ERROR_CODES,
  MarketUpstreamError,
  type MarketSource,
} from './types.js';

export const MARKET_SOURCE_BASES: Record<MarketSource, string> = {
  skillhub: 'https://api.skillhub.cn',
  clawhub: 'https://clawhub.ai',
};

const REQUEST_TIMEOUT_MS = 10_000;

function responseTooLarge(source: MarketSource, label: string, maxBytes: number): MarketUpstreamError {
  return new MarketUpstreamError(
    source,
    MARKET_ERROR_CODES.upstreamBadResponse,
    `${source} ${label} 超过体积上限 (${maxBytes} 字节)`,
  );
}

/** 读响应文本并在超过上限时中止;content-length 虚报时按实际累计拦截。 */
export async function readResponseTextWithLimit(
  source: MarketSource,
  response: Response,
  maxBytes: number,
  label: string,
): Promise<{ content: string; size: number }> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw responseTooLarge(source, label, maxBytes);
  }
  if (!response.body) return { content: '', size: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw responseTooLarge(source, label, maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { content: chunks.join(''), size: total };
  } finally {
    reader.releaseLock();
  }
}

async function fetchOnce(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*' },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function marketFetch(source: MarketSource, url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchOnce(url);
      if (res.status === 429 || res.status >= 500) {
        lastError = new MarketUpstreamError(
          source,
          MARKET_ERROR_CODES.upstreamError,
          `${source} 响应 ${res.status}`,
        );
        continue;
      }
      recordSourceSuccess(source);
      return res;
    } catch (error) {
      if (error instanceof MarketUpstreamError) {
        lastError = error;
        continue;
      }
      const isAbort = error instanceof Error && error.name === 'AbortError';
      lastError = new MarketUpstreamError(
        source,
        isAbort ? MARKET_ERROR_CODES.upstreamTimeout : MARKET_ERROR_CODES.upstreamError,
        isAbort ? `${source} 请求超时` : `${source} 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const finalError = lastError instanceof MarketUpstreamError
    ? lastError
    : new MarketUpstreamError(source, MARKET_ERROR_CODES.upstreamError, `${source} 请求失败`);
  recordSourceFailure(source, finalError.message);
  throw finalError;
}

export async function marketFetchJson<T>(source: MarketSource, url: string): Promise<T> {
  const res = await marketFetch(source, url);
  if (!res.ok) {
    const error = new MarketUpstreamError(
      source,
      MARKET_ERROR_CODES.upstreamError,
      `${source} 响应 ${res.status}: ${new URL(url).pathname}`,
    );
    recordSourceFailure(source, error.message);
    throw error;
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const error = new MarketUpstreamError(source, MARKET_ERROR_CODES.upstreamBadResponse, `${source} 返回了非法 JSON`);
    recordSourceFailure(source, error.message);
    throw error;
  }
}
