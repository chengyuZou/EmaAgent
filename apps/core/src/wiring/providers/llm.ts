import {
  ProvidersRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { ProviderConfig, ModelsDevCatalog } from '@ema-agent/llm';
import {
  getProviderDefinition,
  isLlmProtocol,
  resolveProtocols, resolveBaseUrl,
  type ProtocolFamily,
} from '@ema-agent/contracts';

export function buildLlmProviderConfig(row: ProviderConfigRow): ProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('llm')) return null;

  // config_json may carry a user-selected protocol (when the definition offers
  // multiple choices). Fall back to the first declared protocol.
  const extra    = JSON.parse(row.config_json) as Record<string, unknown>;
  const choices  = resolveProtocols(def.protocols.llm);
  const stored   = typeof extra['protocol'] === 'string' ? extra['protocol'] : undefined;
  const protocol = (stored && choices.includes(stored as never) ? stored : choices[0]) as ProtocolFamily | undefined;
  if (!isLlmProtocol(protocol)) return null;

  const needsKey = def.requiresCredentials !== false;
  if (needsKey && !row.api_key_plain) return null;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? resolveBaseUrl(def, protocol),
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

export function loadLlmConfigs(db: Database): ProviderConfig[] {
  const repo = new ProvidersRepo(db.sqlite);
  const out: ProviderConfig[] = [];
  for (const row of repo.listByCapability('llm')) {
    const cfg = buildLlmProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Live model listing ────────────────────────────────────────────────────────

export interface FetchedModels {
  models: string[];
  /** 'live' = fetched from provider; 'catalog' = from models.dev. */
  source: 'live' | 'catalog';
}

/**
 * Heuristic: is this model id clearly NOT an LLM? `/v1/models` is modality-blind
 * (e.g. SiliconFlow returns embed/rerank/tts/stt/image models in the same list),
 * so we drop obvious non-LLM families by name. Deliberately conservative — bare
 * "audio"/"voice"/"speech" are NOT matched, since multimodal LLMs (gpt-4o-audio)
 * legitimately contain them. The models.dev catalog covers any LLMs the heuristic
 * drops, and live results are merged with catalog before returning.
 */
function isNonLlmModelId(id: string): boolean {
  return /(?:(?:^|[/\-_])(?:bge|m3e|gte|e5|embedding|embed)|rerank|cosyvoice|sensevoice|whisper|tts|sovits|kolors|flux|stable-?diffusion|sdxl|dall-?e|wanx|musicgen)/i.test(id);
}

/**
 * List the LLM models a provider config exposes.
 *
 * Priority:
 *   1. models.dev catalog (in-memory; core loads from online fetch or disk
 *      snapshot at startup — caller passes whichever is available)
 *   2. Live /v1/models — only when catalog has no entry for this provider
 *      (custom self-hosted, Ollama, private deployments, etc.)
 *   3. Empty — user must manually add models
 *
 * Catalog always wins when present: providers like SiliconFlow expose all
 * modalities via /v1/models (embed/rerank/tts mixed in), making heuristic
 * filtering unreliable. models.dev already records only LLM-capable models
 * per provider, so there is no need to probe when catalog data exists.
 */
export async function fetchLlmModels(
  row: ProviderConfigRow,
  opts?: {
    modelsDevId?:   string;
    modelCatalog?:  ModelsDevCatalog;
    signal?:        AbortSignal;
  },
): Promise<FetchedModels> {
  // 1. models.dev catalog (online or disk snapshot — already resolved by caller)
  const catalogModels = opts?.modelsDevId && opts?.modelCatalog
    ? opts.modelCatalog.listLlmModelIds(opts.modelsDevId)
    : [];

  if (catalogModels.length > 0) {
    return { models: catalogModels, source: 'catalog' };
  }

  // 2. Live /v1/models — only for providers not tracked by models.dev
  const cfg = buildLlmProviderConfig(row);
  if (cfg && (cfg.protocol === 'openai-llm' || cfg.protocol === 'openai-responses-llm')) {
    const base = (cfg.baseUrl ?? '').replace(/\/$/, '');
    if (base) {
      try {
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          signal:  opts?.signal ?? AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const body = await res.json() as { data?: Array<{ id?: string }> };
          const liveIds = (body.data ?? [])
            .map((m) => m.id)
            .filter((id): id is string => !!id)
            .filter((id) => !isNonLlmModelId(id));
          if (liveIds.length > 0) {
            return { models: liveIds, source: 'live' };
          }
        }
      } catch { /* probe failed */ }
    }
  }

  // 3. Empty — user must manually add models via the model manager
  return { models: [], source: 'catalog' };
}
