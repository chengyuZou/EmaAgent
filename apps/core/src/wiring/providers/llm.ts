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
 * Fallback chain:
 *   1. Live /v1/models (openai-style protocols only)
 *   2. models.dev catalog (when modelsDevId is known)
 *   3. Empty — user must manually enable models
 *
 * `defaultModels.llm` is intentionally NOT used as fallback — the static list
 * is a maintenance burden and the models.dev catalog supersedes it. Users can
 * still manually add models via the settings UI's model manager.
 */
export async function fetchLlmModels(
  row: ProviderConfigRow,
  opts?: {
    modelsDevId?:   string;
    modelCatalog?:  ModelsDevCatalog;
    signal?:        AbortSignal;
  },
): Promise<FetchedModels> {
  const catalogModels = opts?.modelsDevId && opts?.modelCatalog
    ? opts.modelCatalog.listLlmModelIds(opts.modelsDevId)
    : [];

  const cfg = buildLlmProviderConfig(row);

  // Live /v1/models probe — supplements the catalog for custom / self-hosted
  // models that models.dev doesn't track.
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
          const merged = [...new Set([...catalogModels, ...liveIds])].sort();
          return { models: merged, source: 'live' };
        }
      } catch { /* probe failed — fall through to catalog */ }
    }
  }

  // models.dev catalog is the primary source for non-OpenAI providers
  // (Anthropic, Gemini) and the fallback when live probe fails.
  return { models: catalogModels, source: 'catalog' };
}
