import {
  ProvidersRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { RerankProviderConfig } from '@ema-agent/ebd-client';
import type { CredentialFacade } from '@ema-agent/credential';
import {
  providerCatalog,
  isRerankProtocol,
  requiresCredentials,
} from '@ema-agent/provider';
import {
  capabilityConfigFor,
  configuredBaseUrlFor,
  selectedProtocolFor,
} from './config-resolution.js';

export function buildRerankProviderConfig(row: ProviderConfigRow): RerankProviderConfig | null {
  const def = providerCatalog.get(row.definition_id);
  if (!def) return null;

  const capability = capabilityConfigFor(row, 'rerank');
  if (!capability) return null;

  const protocol = selectedProtocolFor(def, 'rerank', capability);
  if (!isRerankProtocol(protocol)) return null;

  if (requiresCredentials(def) && !row.credential) return null;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.credential ?? '',
    baseUrl:      configuredBaseUrlFor(def, 'rerank', capability, protocol),
  };
}

export function loadRerankConfigs(db: Database, credentials: CredentialFacade): RerankProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite, credentials);
  const out: RerankProviderConfig[] = [];
  for (const row of repo.listByCapability('rerank')) {
    const cfg = buildRerankProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}
