import {
  ProvidersRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { EmbedProviderConfig } from '@ema-agent/ebd-client';
import type { CredentialFacade } from '@ema-agent/credential';
import {
  providerCatalog,
  isEmbedProtocol,
  requiresCredentials,
  staticModelsFor,
} from '@ema-agent/provider';
import {
  capabilityConfigFor,
  configuredBaseUrlFor,
  selectedProtocolFor,
} from './config-resolution.js';

// ── Live model listing ────────────────────────────────────────────────────────

export interface FetchedEmbedModels {
  models: string[];
  source: 'live' | 'static';
}

/**
 * Positive filter: keep only model ids that look like embedding models.
 * Unlike LLM (negative filter), embed providers on mixed APIs (SiliconFlow)
 * return LLM + embed + rerank together — we want only the embed ones.
 */
function isEmbedModelId(id: string): boolean {
  return /(?:bge|m3e|gte|e5(?:-|$)|embed|embedding|text-embed|reembed|nomic-embed|mxbai-embed|jina-embed|jina-clip)/i.test(id);
}

/**
 * List the embed models a provider config exposes.
 * openai-embed protocol supports GET /v1/models; we positively filter for
 * embed-like names and union with the definition's curated defaultModels.embed.
 */
export async function fetchEmbedModels(row: ProviderConfigRow, signal?: AbortSignal): Promise<FetchedEmbedModels> {
  const def = providerCatalog.get(row.definition_id);
  const staticList = def ? [...staticModelsFor(def, 'embed')] : [];
  const cfg = buildEmbedProviderConfig(row);

  if (!cfg || cfg.protocol !== 'openai-embed') {
    return { models: staticList, source: 'static' };
  }

  const base = (cfg.baseUrl ?? '').replace(/\/$/, '');
  if (!base) return { models: staticList, source: 'static' };

  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal:  signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { models: staticList, source: 'static' };
    const body = await res.json() as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id)
      .filter(isEmbedModelId);
    if (ids.length === 0) return { models: staticList, source: 'static' };
    const merged = [...new Set([...ids, ...staticList])].sort();
    return { models: merged, source: 'live' };
  } catch {
    return { models: staticList, source: 'static' };
  }
}

export function buildEmbedProviderConfig(row: ProviderConfigRow): EmbedProviderConfig | null {
  const def = providerCatalog.get(row.definition_id);
  if (!def) return null;

  const capability = capabilityConfigFor(row, 'embed');
  if (!capability) return null;

  const protocol = selectedProtocolFor(def, 'embed', capability);
  if (!isEmbedProtocol(protocol)) return null;

  if (requiresCredentials(def) && !row.credential) return null;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.credential ?? '',
    baseUrl:      configuredBaseUrlFor(def, 'embed', capability, protocol),
    embeddingRevision: capability.embedding_revision ?? undefined,
  };
}

export function loadEmbedConfigs(db: Database, credentials: CredentialFacade): EmbedProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite, credentials);
  const out: EmbedProviderConfig[] = [];
  for (const row of repo.listByCapability('embed')) {
    const cfg = buildEmbedProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}
