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
    const nextEntries = this.buildEntries(configs, this.entries);
    const affectedProviderIds = new Set<string>();
    for (const [providerId, previous] of this.entries) {
      if (nextEntries.get(providerId) !== previous) affectedProviderIds.add(providerId);
    }
    for (const providerId of nextEntries.keys()) {
      if (!this.entries.has(providerId)) affectedProviderIds.add(providerId);
    }
    this.entries = nextEntries;
    return affectedProviderIds;
  }

  upsert(config: ProviderConfig): boolean {
    const previous = this.entries.get(config.id);
    if (previous && providerConfigsEqual(previous.config, config)) return false;
    const entry = this.createEntry(config);
    const nextEntries = new Map(this.entries);
    nextEntries.set(config.id, entry);
    this.entries = nextEntries;
    return true;
  }

  remove(providerId: string): boolean {
    if (!this.entries.has(providerId)) return false;
    const nextEntries = new Map(this.entries);
    nextEntries.delete(providerId);
    this.entries = nextEntries;
    return true;
  }

  private buildEntries(
    configs: readonly ProviderConfig[],
    previousEntries?: ReadonlyMap<string, ProviderRuntimeEntry>,
  ): Map<string, ProviderRuntimeEntry> {
    const entries = new Map<string, ProviderRuntimeEntry>();
    for (const config of configs) {
      if (entries.has(config.id)) {
        throw new Error(`provider/duplicate_config: ${config.id}`);
      }
      const previous = previousEntries?.get(config.id);
      entries.set(
        config.id,
        previous && providerConfigsEqual(previous.config, config)
          ? previous
          : this.createEntry(config),
      );
    }
    return entries;
  }

  private createEntry(config: ProviderConfig): ProviderRuntimeEntry {
    const configSnapshot = Object.freeze({ ...config });
    return Object.freeze({
      config: configSnapshot,
      adapter: this.createAdapter(configSnapshot),
    });
  }
}

function providerConfigsEqual(left: ProviderConfig, right: ProviderConfig): boolean {
  return left.id === right.id
    && left.protocol === right.protocol
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl
    && left.modelsDevId === right.modelsDevId;
}
