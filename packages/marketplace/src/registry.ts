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

  /** 注册一个业务包的 adapter。同 kind 重复注册覆盖(后注册者赢)。 */
  registerAdapter<Entry>(adapter: MarketSourceAdapter<Entry>): void {
    this.adapters.set(adapter.kind, adapter as MarketSourceAdapter<unknown>);
  }

  /** 取某 kind 的 adapter(未注册返回 undefined)。 */
  getAdapter(kind: string): MarketSourceAdapter<unknown> | undefined {
    return this.adapters.get(kind);
  }

  /** 列出已注册的所有 kind(调试/UI 用)。 */
  registeredKinds(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * 并发 fetch 该 kind 所有 enabled 源,合并返回每个源的结果(含 error)。
   * 单源失败不阻断 —— 该源 entries=[] + error 填上,其他源正常返回。
   * 调用方负责把 entries 合并成最终列表(去重逻辑业务包自定)。
   */
  async listAll<Entry>(
    kind:    string,
    sources: readonly MarketSourceRecord[],
  ): Promise<MarketSourceResult<Entry>[]> {
    const adapter = this.getAdapter(kind);
    if (!adapter) return [];

    const enabled = sources.filter((s) => s.enabled && s.kind === kind);
    return Promise.all(
      enabled.map(async (source): Promise<MarketSourceResult<Entry>> => {
        try {
          const entries = await (adapter as MarketSourceAdapter<Entry>).list(source);
          return {
            sourceId:    source.id,
            sourceLabel: source.label,
            sourceType:  source.type,
            entries,
          };
        } catch (err) {
          return {
            sourceId:    source.id,
            sourceLabel: source.label,
            sourceType:  source.type,
            entries:     [],
            error:       err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }
}
