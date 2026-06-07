import {
  ProvidersRepo,
  EmbedModelCatalogRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { EmbedProviderConfig } from '@ema-agent/ebd-client';
import {
  getProviderDefinition,
  isEmbedProtocol,
  resolveProtocols,
  type ProtocolFamily,
} from '@ema-agent/contracts';

export function buildEmbedProviderConfig(
  row:          ProviderConfigRow,
  embedCatalog: EmbedModelCatalogRepo,
): EmbedProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('embed')) return null;

  const protocol = resolveProtocols(def.protocols.embed)[0] as ProtocolFamily | undefined;
  if (!isEmbedProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra        = JSON.parse(row.config_json) as Record<string, unknown>;
  const defaultModel = typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined;
  // Vector dimension is a model property — look it up from embed_model_catalog.
  const dim = defaultModel ? embedCatalog.dim(defaultModel) : 0;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    dim,
    defaultModel,
  };
}

export function loadEmbedConfigs(
  db:           Database,
  embedCatalog: EmbedModelCatalogRepo,
): EmbedProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: EmbedProviderConfig[] = [];
  for (const row of repo.listByCapability('embed')) {
    const cfg = buildEmbedProviderConfig(row, embedCatalog);
    if (cfg) out.push(cfg);
  }
  return out;
}
