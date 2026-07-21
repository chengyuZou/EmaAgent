// 这里注册各业务市场 Adapter, 并以有界并发和稳定顺序聚合启用的市场源.
import type { MarketSourceAdapter, MarketSourceRecord } from './types.js';

// ── 单源聚合结果 ──────────────────────────────────────────────────────────────

export interface MarketSourceResult<Entry> {
  sourceId:    string;
  sourceLabel: string;
  sourceType:  string;
  entries:     Entry[];
  /** 单源 fetch 失败时填,不阻断其他源 */
  error?:      string;
}

// ── MarketRegistry ────────────────────────────────────────────────────────────
//
// adapter 注册表 + 并发聚合调度。底座不知道 Entry 具体形状,由调用方泛型化。
// listAll 并发 fetch 该 kind 所有 enabled 源,单源失败不阻断(返回该源 error)。

export class MarketRegistry {
  /** kind → adapter */
  private readonly adapters = new Map<string, MarketSourceAdapter<unknown>>();

  constructor(private readonly maxConcurrency = 4) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new RangeError('maxConcurrency 必须是正整数');
    }
  }

  /** 注册一个业务包的 adapter; 同 kind 重复注册说明接线冲突, 启动时直接失败. */
  registerAdapter<Entry>(adapter: MarketSourceAdapter<Entry>): void {
    if (!adapter.kind.trim()) throw new Error('市场 Adapter kind 不能为空');
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`市场 Adapter kind 重复注册: ${adapter.kind}`);
    }
    this.adapters.set(adapter.kind, adapter as MarketSourceAdapter<unknown>);
  }

  /** 取某 kind 的 adapter(未注册返回 undefined)。 */
  getAdapter(kind: string): MarketSourceAdapter<unknown> | undefined {
    return this.adapters.get(kind);
  }

  /** 列出已注册的所有 kind(调试/UI 用)。 */
  registeredKinds(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * 并发 fetch 该 kind 所有 enabled 源,合并返回每个源的结果(含 error)。
   * 单源失败不阻断 —— 该源 entries=[] + error 填上,其他源正常返回。
   * 调用方负责把 entries 合并成最终列表(去重逻辑业务包自定)。
   */
  async listAll<Entry>(
    kind:    string,
    sources: readonly MarketSourceRecord[],
    signal?: AbortSignal,
  ): Promise<MarketSourceResult<Entry>[]> {
    const adapter = this.getAdapter(kind);
    if (!adapter) return [];

    const enabled = sources
      .filter((source) => source.enabled && source.kind === kind)
      .sort(compareSources);
    return mapWithConcurrency(
      enabled,
      this.maxConcurrency,
      async (source): Promise<MarketSourceResult<Entry>> => {
        if (signal?.aborted) throw abortReason(signal);
        try {
          const entries = await (adapter as MarketSourceAdapter<Entry>).list(source, signal);
          return {
            sourceId:    source.id,
            sourceLabel: source.label,
            sourceType:  source.type,
            entries,
          };
        } catch (err) {
          if (signal?.aborted) throw abortReason(signal);
          return {
            sourceId:    source.id,
            sourceLabel: source.label,
            sourceType:  source.type,
            entries:     [],
            error:       err instanceof Error ? err.message : String(err),
          };
        }
      },
      signal,
    );
  }
}

function compareSources(left: MarketSourceRecord, right: MarketSourceRecord): number {
  return left.sortOrder - right.sortOrder
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input) => Promise<Output>,
  signal?: AbortSignal,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        if (signal?.aborted) throw abortReason(signal);
        const index = nextIndex++;
        results[index] = await worker(values[index]!);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('市场聚合请求已取消');
}

// ── 合并 helper(业务包共用,保证跨源去重策略一致)──────────────────────────────

/**
 * 按 entry.name 合并多源结果,先到先得 —— 后源同名不覆盖前源。
 * listAll 返回的 results 按 source.sortOrder 升序保序,所以"先到"= sortOrder 小的优先
 * (builtin 官方源 sortOrder 0 优先于用户自加源)。
 * 业务包调 listAll 后用这个去重,避免 mcp/skill 各写一套漂移。
 */
export function mergeByName<Entry extends { name: string }>(
  results: readonly MarketSourceResult<Entry>[],
): Entry[] {
  const seen = new Map<string, Entry>();
  for (const r of results) {
    for (const entry of r.entries) {
      if (!seen.has(entry.name)) seen.set(entry.name, entry);
    }
  }
  return [...seen.values()];
}
