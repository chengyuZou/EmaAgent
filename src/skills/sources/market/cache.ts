// 市场内存缓存:TTL + 过期兜底(stale-while-error) + 按来源健康记录。
// 只存归一化后的上游数据;安装状态每请求现算,永不进缓存。
import type { MarketSource, SourceHealthStatus, SourceStatusInfo } from './types.js';

type CacheEntry = {
  value: unknown;
  expiresAt: number;
  storedAt: number;
};

const MAX_ENTRIES = 500;

export const MARKET_TTL = {
  list: 5 * 60_000,
  search: 2 * 60_000,
  detail: 10 * 60_000,
  fileContent: 30 * 60_000,
} as const;

class MarketCache {
  private entries = new Map<string, CacheEntry>();

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) return undefined;
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  /** 过期也返回——上游失败时拿旧数据兜底。 */
  getStale<T>(key: string): { value: T; storedAt: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { value: entry.value as T, storedAt: entry.storedAt };
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, storedAt: Date.now() });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const marketCache = new MarketCache();

// ── 来源健康(市场窗口的状态行) ──────────────────────────────────────────────

type HealthRecord = {
  status: SourceHealthStatus;
  lastOkAt?: number;
  lastError?: string;
};

const sourceHealth = new Map<MarketSource, HealthRecord>();

export function recordSourceSuccess(source: MarketSource): void {
  sourceHealth.set(source, { status: 'ok', lastOkAt: Date.now() });
}

export function recordSourceFailure(source: MarketSource, error: string): void {
  const prev = sourceHealth.get(source);
  sourceHealth.set(source, {
    // 刚成功过 → 降级;连续失败 → failed。
    status: prev?.status === 'ok' && prev.lastOkAt ? 'degraded' : 'failed',
    lastOkAt: prev?.lastOkAt,
    lastError: error,
  });
}

export function getSourceHealth(source: MarketSource): SourceStatusInfo {
  const record = sourceHealth.get(source);
  return {
    status: record?.status ?? 'ok',
    ...(record?.lastOkAt !== undefined ? { fetchedAt: record.lastOkAt } : {}),
    ...(record?.lastError !== undefined ? { error: record.lastError } : {}),
  };
}
