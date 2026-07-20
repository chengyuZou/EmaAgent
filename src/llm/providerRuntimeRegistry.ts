// 维护 Provider 配置与协议 Adapter 的原子运行时快照，供单次模型调用稳定引用。
import type { LlmAdapter } from './adapters/base.js';
import type { ProviderConfig } from './types.js';

export interface ProviderRuntimeEntry {
  readonly config: ProviderConfig;
  readonly adapter: LlmAdapter;
}

type AdapterFactory = (config: ProviderConfig) => LlmAdapter;

export class ProviderRuntimeRegistry {
  private entries = new Map<string, ProviderRuntimeEntry>();

  constructor(configs: readonly ProviderConfig[], private readonly createAdapter: AdapterFactory) {
    this.entries = this.buildEntries(configs);
  }

  get(providerId: string): ProviderRuntimeEntry | undefined {
    return this.entries.get(providerId);
  }

  replace(configs: readonly ProviderConfig[]): ReadonlySet<string> {
    const nextEntries = this.buildEntries(configs);
    const affectedProviderIds = new Set([
      ...this.entries.keys(),
      ...nextEntries.keys(),
    ]);
    this.entries = nextEntries;
    return affectedProviderIds;
  }

  upsert(config: ProviderConfig): void {
    const entry = this.createEntry(config);
    const nextEntries = new Map(this.entries);
    nextEntries.set(config.id, entry);
    this.entries = nextEntries;
  }

  remove(providerId: string): void {
    if (!this.entries.has(providerId)) return;
    const nextEntries = new Map(this.entries);
    nextEntries.delete(providerId);
    this.entries = nextEntries;
  }

  firstProviderId(): string | undefined {
    return this.entries.keys().next().value;
  }

  defaultModelFor(providerId: string): string | undefined {
    return this.entries.get(providerId)?.config.defaultModel;
  }

  private buildEntries(configs: readonly ProviderConfig[]): Map<string, ProviderRuntimeEntry> {
    const entries = new Map<string, ProviderRuntimeEntry>();
    for (const config of configs) entries.set(config.id, this.createEntry(config));
    return entries;
  }

  private createEntry(config: ProviderConfig): ProviderRuntimeEntry {
    return Object.freeze({
      config: Object.freeze({ ...config }),
      adapter: this.createAdapter(config),
    });
  }
}
