/**
 * models.dev catalog — LLM/Vision model facts pulled from https://models.dev/api.json
 * instead of hardcoding context windows and capability flags.
 *
 * Shape of api.json (verified against models.dev build):
 *   { [providerId]: { ...provider fields, models: { [modelId]: ModelSpec } } }
 *   ModelSpec: { id, name, reasoning, tool_call, temperature, structured_output?,
 *               modalities: { input: string[], output: string[] }, limit: { context, output? } }
 *
 * Indexed by `modelsDevId` (the provider's models.dev folder id — see
 * ProviderDefinition.modelsDevId), so a configured EmaAgent provider resolves to
 * the right models.dev provider. Providers models.dev doesn't track (local
 * runtimes, embed/rerank/tts-only) simply have no entry and fall back to the
 * provider's own `/models` endpoint or manual entry.
 *
 * Pure logic: no fs, no hardcoded I/O beyond an injectable fetch. apps/core owns
 * cache persistence (write the raw payload to disk, re-`loadFromJson` on startup)
 * and the startup background `refresh()`.
 */

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

export interface ModelsDevSpec {
  id:                string;
  /** Context window in tokens. undefined when models.dev doesn't state it. */
  contextWindow?:    number;
  /** Max output tokens. undefined when unstated. */
  maxOutput?:        number;
  /** Input modalities, e.g. ['text','image','file']. */
  inputModalities:   string[];
  /** Output modalities, e.g. ['text'] or ['image']. */
  outputModalities:  string[];
  toolCall:          boolean;
  reasoning:         boolean;
  /** false → the model rejects `temperature` (o-series / reasoning models). */
  temperature:       boolean;
  structuredOutput:  boolean;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export class ModelsDevCatalog {
  /** modelsDevId → (modelId → spec) */
  private readonly index = new Map<string, Map<string, ModelsDevSpec>>();
  /** modelId → spec — flat secondary index for O(1) provider-agnostic lookups. */
  private readonly flat  = new Map<string, ModelsDevSpec>();
  private loadedAt: number | null = null;

  /** Parse a models.dev api.json payload. Tolerant of missing/extra fields. */
  loadFromJson(payload: unknown): void {
    const providers = asRecord(payload);
    if (!providers) return;

    const next     = new Map<string, Map<string, ModelsDevSpec>>();
    const nextFlat = new Map<string, ModelsDevSpec>();
    for (const [providerId, providerVal] of Object.entries(providers)) {
      const prov = asRecord(providerVal);
      const models = prov && asRecord(prov['models']);
      if (!models) continue;

      const modelMap = new Map<string, ModelsDevSpec>();
      for (const [modelId, modelVal] of Object.entries(models)) {
        const m = asRecord(modelVal);
        if (!m) continue;
        const limit      = asRecord(m['limit']);
        const modalities = asRecord(m['modalities']);
        const spec: ModelsDevSpec = {
          id:               typeof m['id'] === 'string' ? m['id'] : modelId,
          contextWindow:    limit ? asNumber(limit['context']) : undefined,
          maxOutput:        limit ? asNumber(limit['output'])  : undefined,
          inputModalities:  modalities ? asStringArray(modalities['input'])  : [],
          outputModalities: modalities ? asStringArray(modalities['output']) : [],
          toolCall:         m['tool_call'] === true,
          reasoning:        m['reasoning'] === true,
          // Absent temperature flag → assume supported (most chat models accept it).
          temperature:      m['temperature'] !== false,
          structuredOutput: m['structured_output'] === true,
        };
        modelMap.set(modelId, spec);
        // Flat index: first provider entry wins for a given modelId.
        if (!nextFlat.has(modelId)) nextFlat.set(modelId, spec);
      }
      if (modelMap.size > 0) next.set(providerId, modelMap);
    }

    // Replace wholesale — a refresh always reflects the latest snapshot.
    this.index.clear();
    this.flat.clear();
    for (const [k, v] of next) this.index.set(k, v);
    for (const [k, v] of nextFlat) this.flat.set(k, v);
    this.loadedAt = Date.now();
  }

  /**
   * Fetch + parse from models.dev. Returns the raw payload on success (so the
   * caller can cache it) or null on failure — the existing index is preserved.
   */
  async refresh(opts: { fetchFn?: typeof fetch; url?: string; signal?: AbortSignal } = {}): Promise<unknown | null> {
    const doFetch = opts.fetchFn ?? fetch;
    try {
      const res = await doFetch(opts.url ?? MODELS_DEV_API_URL, { signal: opts.signal });
      if (!res.ok) return null;
      const payload: unknown = await res.json();
      this.loadFromJson(payload);
      return payload;
    } catch {
      return null;
    }
  }

  get(modelsDevId: string, modelId: string): ModelsDevSpec | undefined {
    return this.index.get(modelsDevId)?.get(modelId);
  }

  /** Provider-agnostic spec lookup via the flat secondary index. O(1). */
  getByModelId(modelId: string): ModelsDevSpec | undefined {
    return this.flat.get(modelId);
  }

  /** Context window for a model, searching by bare model id. */
  contextWindowOf(modelId: string): number | undefined {
    return this.flat.get(modelId)?.contextWindow;
  }

  /** Max output tokens for a model, searching by bare model id. */
  maxOutputOf(modelId: string): number | undefined {
    return this.flat.get(modelId)?.maxOutput;
  }

  /** True if the model is marked as reasoning-capable. */
  hasReasoning(modelId: string): boolean {
    return this.flat.get(modelId)?.reasoning === true;
  }

  /**
   * Provider-agnostic fuzzy suggestions for a model-name input (settings UI).
   * Returns LLM model ids whose id contains `query`, with their context window.
   * Deduped across providers (first context wins).
   */
  suggest(query: string, limit = 8): Array<{ id: string; contextWindow: number }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ id: string; contextWindow: number }> = [];
    for (const spec of this.flat.values()) {
      if (!spec.id.toLowerCase().includes(q)) continue;
      // LLM-ish only: output text (skip pure image/video gen).
      if (spec.outputModalities.length > 0 && !spec.outputModalities.includes('text')) continue;
      results.push({ id: spec.id, contextWindow: spec.contextWindow ?? 0 });
      if (results.length >= limit) break;
    }
    return results;
  }

  /** All model ids models.dev lists for this provider. */
  listModelIds(modelsDevId: string): string[] {
    return [...(this.index.get(modelsDevId)?.keys() ?? [])];
  }

  /** Chat/LLM model ids — output includes 'text' (excludes pure image/video gen). */
  listLlmModelIds(modelsDevId: string): string[] {
    const map = this.index.get(modelsDevId);
    if (!map) return [];
    return [...map.values()]
      .filter(s => s.outputModalities.length === 0 || s.outputModalities.includes('text'))
      .map(s => s.id);
  }

  /** Vision model ids — output includes 'text' AND input includes 'image'. */
  listVisionModelIds(modelsDevId: string): string[] {
    const map = this.index.get(modelsDevId);
    if (!map) return [];
    return [...map.values()]
      .filter(s =>
        (s.outputModalities.length === 0 || s.outputModalities.includes('text')) &&
        s.inputModalities.includes('image'),
      )
      .map(s => s.id);
  }

  /** Vision gate: does this LLM accept image input? Drives orchestrator fallback. */
  supportsImageInput(modelsDevId: string, modelId: string): boolean {
    return (this.get(modelsDevId, modelId) ?? this.flat.get(modelId))?.inputModalities.includes('image') ?? false;
  }

  get size(): number {
    return this.flat.size;
  }

  get lastLoadedAt(): number | null {
    return this.loadedAt;
  }
}
