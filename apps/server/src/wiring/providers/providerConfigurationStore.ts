// 把 Storage 的 SQL 行结构转换成 Provider 控制面使用的明确业务结构。
import type {
  ConfiguredProvider,
  ProviderCapabilityConfiguration,
  ProviderConfigurationStore,
  ProviderHealthSnapshot,
  ProviderWithHealth,
  SaveProviderConfiguration,
} from '@ema-agent/provider';
import type {
  ProviderCapabilityConfigRow,
  ProviderConfigRow,
  ProviderHealthRow,
  ProvidersRepo,
} from '@ema-agent/storage';

export class StorageProviderConfigurationStore implements ProviderConfigurationStore {
  constructor(private readonly repo: ProvidersRepo) {}

  get(id: string): ConfiguredProvider | undefined {
    const row = this.repo.get(id);
    return row ? mapProvider(row) : undefined;
  }

  getWithHealth(id: string): ProviderWithHealth | undefined {
    const snapshot = this.repo.getWithHealth(id);
    if (!snapshot) return undefined;
    return {
      config: mapProvider(snapshot.config),
      health: mapHealth(snapshot.health),
    };
  }

  listWithHealth(): ProviderWithHealth[] {
    return this.repo.listWithHealth().map((snapshot) => ({
      config: mapProvider(snapshot.config),
      health: mapHealth(snapshot.health),
    }));
  }

  save(input: SaveProviderConfiguration): void {
    this.repo.upsert({
      id: input.id,
      definitionId: input.definitionId,
      displayName: input.displayName,
      apiKey: input.credential,
      enabled: input.enabled,
      capabilities: input.capabilities,
    });
  }

  delete(id: string): void {
    this.repo.delete(id);
  }
}

function mapProvider(row: ProviderConfigRow): ConfiguredProvider {
  return {
    id: row.id,
    definitionId: row.definition_id,
    displayName: row.display_name,
    credential: row.credential,
    enabled: row.enabled === 1,
    capabilities: row.capabilities.map(mapCapability),
  };
}

function mapCapability(
  row: ProviderCapabilityConfigRow,
): ProviderCapabilityConfiguration {
  return {
    capability: row.capability,
    protocol: row.protocol,
    baseUrl: row.base_url,
    embeddingRevision: row.embedding_revision,
    enabled: row.enabled === 1,
  };
}

function mapHealth(row: ProviderHealthRow | null): ProviderHealthSnapshot | null {
  if (!row) return null;
  return {
    status: row.status,
    lastProbedAt: row.last_probed_at,
    latencyMs: row.latency_ms,
    lastError: row.last_error,
  };
}
