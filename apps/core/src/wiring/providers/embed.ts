import {
  ProvidersRepo,
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
  const def = getProviderDefinition(row.definition_id);
  const staticList = [...(def?.defaultModels?.embed ?? [])];
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
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('embed')) return null;

  const protocol = resolveProtocols(def.protocols.embed)[0] as ProtocolFamily | undefined;
  if (!isEmbedProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

export function loadEmbedConfigs(db: Database): EmbedProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: EmbedProviderConfig[] = [];
  for (const row of repo.listByCapability('embed')) {
    const cfg = buildEmbedProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}
