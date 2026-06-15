import {
  ProvidersRepo,
  type ProviderConfigRow,
  type Database,
} from '@ema-agent/storage';
import type { ProviderConfig } from '@ema-agent/llm';
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
  /** 'live' = fetched from the provider; 'static' = definition's defaultModels fallback. */
  source: 'live' | 'static';
}

/**
 * Heuristic: is this model id clearly NOT an LLM? `/v1/models` is modality-blind
 * (e.g. SiliconFlow returns embed/rerank/tts/stt/image models in the same list),
 * so we drop obvious non-LLM families by name. Deliberately conservative — bare
 * "audio"/"voice"/"speech" are NOT matched, since multimodal LLMs (gpt-4o-audio)
 * legitimately contain them; curated defaultModels are unioned back regardless.
 */
function isNonLlmModelId(id: string): boolean {
  return /(?:(?:^|[/\-_])(?:bge|m3e|gte|e5|embedding|embed)|rerank|cosyvoice|sensevoice|whisper|tts|sovits|kolors|flux|stable-?diffusion|sdxl|dall-?e|wanx|musicgen)/i.test(id);
}

/**
 * List the LLM models a provider config exposes.
 *
 * OpenAI-compatible protocols expose `GET {baseUrl}/models` (id list); we hit
 * it live so the picker reflects the key's real entitlements. Anthropic/Gemini
 * have no uniform list endpoint here, and any failure (network, 401, non-OpenAI
 * shape) falls back to the definition's curated `defaultModels.llm`.
 *
 * Note: OpenAI's /models does NOT carry context length — windows come from the
 * token table downstream, not from here.
 */
export async function fetchLlmModels(row: ProviderConfigRow, signal?: AbortSignal): Promise<FetchedModels> {
  const def = getProviderDefinition(row.definition_id);
  const staticList = [...(def?.defaultModels?.llm ?? [])];
  const cfg = buildLlmProviderConfig(row);

  // Only openai-style protocols have the /v1/models list endpoint.
  if (!cfg || (cfg.protocol !== 'openai-llm' && cfg.protocol !== 'openai-responses-llm')) {
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
      // /v1/models is modality-blind — drop obvious non-LLM families by name.
      .filter((id) => !isNonLlmModelId(id));
    if (ids.length === 0) return { models: staticList, source: 'static' };
    // Union with curated static LLM list (covers any LLM the heuristic dropped).
    const merged = [...new Set([...ids, ...staticList])].sort();
    return { models: merged, source: 'live' };
  } catch {
    return { models: staticList, source: 'static' };
  }
}
