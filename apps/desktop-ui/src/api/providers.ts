/**
 * Providers API — CRUD + definitions + health probe.
 * ProviderDefinition imported from @ema-agent/contracts.
 */
import { sidecarClient } from './sidecar-client.js';
import type { ProviderDefinition } from '@ema-agent/contracts';

export type { ProviderDefinition };

export interface ProviderHealthWire {
  status:       string;
  latencyMs:    number | null;
  lastError:    string | null;
  lastProbedAt: number | null;
}

export interface ProviderConfigWire {
  id:           string;
  definitionId: string;
  displayName:  string;
  hasApiKey:    boolean;
  baseUrl:      string | null;
  enabled:      boolean;
  capabilities: string[];
  config:       Record<string, unknown>;
  health:       ProviderHealthWire | null;
  definition:   ProviderDefinition | null;
}

export interface ProviderConfigInput {
  definitionId: string;
  displayName?: string;
  apiKey?:      string;
  baseUrl?:     string | null;
  enabled?:     boolean;
  capabilities?: string[];
  config?:      Record<string, unknown>;
}

export interface ProbeResultWire {
  ok:        boolean;
  model:     string;
  latencyMs: number | null;
  error?:    string;
}

export interface AvailableModelWire {
  id:            string;
  /** From token table / enabled row; null when unknown (user must fill on enable). */
  contextWindow: number | null;
  enabled:       boolean;
}

export interface ModelsListWire {
  source: 'live' | 'catalog';
  models: AvailableModelWire[];
}

export interface AvailableEmbedModelWire {
  id:      string;
  dim:     number | null;
  enabled: boolean;
}

export interface EmbedModelsListWire {
  source: 'live' | 'static';
  models: AvailableEmbedModelWire[];
}

export interface AvailableRerankModelWire {
  id:        string;
  maxChunks: number | null;
  enabled:   boolean;
}

export interface RerankModelsListWire {
  source: 'static';
  models: AvailableRerankModelWire[];
}

export interface AvailableSimpleModelWire {
  id:      string;
  enabled: boolean;
}

export interface SimpleModelsListWire {
  source: 'static';
  models: AvailableSimpleModelWire[];
}

// ── API object ────────────────────────────────────────────────────────────────

export const providersApi = {
  /** GET /api/providers/definitions — static registry. */
  async listDefinitions(): Promise<ProviderDefinition[]> {
    return sidecarClient.request<ProviderDefinition[]>('/api/providers/definitions');
  },

  /** GET /api/providers — user-configured providers with health. */
  async list(): Promise<ProviderConfigWire[]> {
    return sidecarClient.request<ProviderConfigWire[]>('/api/providers');
  },

  /** GET /api/providers/:id */
  async get(id: string): Promise<ProviderConfigWire> {
    return sidecarClient.request<ProviderConfigWire>(`/api/providers/${id}`);
  },

  /** GET /api/providers/:id/key — reveal stored key so the edit form prefills it. */
  async getKey(id: string): Promise<string> {
    const r = await sidecarClient.request<{ apiKey: string }>(`/api/providers/${id}/key`);
    return r.apiKey;
  },

  /** POST /api/providers */
  async create(input: ProviderConfigInput): Promise<ProviderConfigWire> {
    return sidecarClient.request<ProviderConfigWire>('/api/providers', {
      method: 'POST',
      json: input,
    });
  },

  /** PATCH /api/providers/:id */
  async patch(id: string, input: Partial<ProviderConfigInput>): Promise<ProviderConfigWire> {
    return sidecarClient.request<ProviderConfigWire>(`/api/providers/${id}`, {
      method: 'PATCH',
      json: input,
    });
  },

  /** DELETE /api/providers/:id */
  async delete(id: string): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}`, { method: 'DELETE' });
  },

  /** POST /api/providers/:id/probe */
  async probe(id: string, model?: string): Promise<ProbeResultWire> {
    return sidecarClient.request<ProbeResultWire>(`/api/providers/${id}/probe`, {
      method: 'POST',
      json: { model },  // undefined → backend picks definition's first LLM model
    });
  },

  /** GET /api/providers/:id/models — available LLM models (live or static) + enabled flags. */
  async listModels(id: string): Promise<ModelsListWire> {
    return sidecarClient.request<ModelsListWire>(`/api/providers/${id}/models`);
  },

  /** PUT /api/providers/:id/models/:model — enable a model with its context window. */
  async enableModel(id: string, model: string, contextWindow: number, contextSource?: 'live' | 'table' | 'manual'): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}/models/${encodeURIComponent(model)}`, {
      method: 'PUT',
      json: { contextWindow, contextSource },
    });
  },

  /** DELETE /api/providers/:id/models/:model — disable; cascades to bindings. */
  async disableModel(id: string, model: string): Promise<{ ok: boolean; cascadedBindings: number }> {
    return sidecarClient.request<{ ok: boolean; cascadedBindings: number }>(
      `/api/providers/${id}/models/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
  },

  /**
   * POST /api/providers/:id/tts-test — real TTS synthesis test.
   * Returns the synthesized audio as a Blob to play, or throws with the
   * backend error message (no reference audio / upload failed / etc.).
   */
  async testTts(id: string, model: string, text?: string): Promise<Blob> {
    const res = await sidecarClient.requestRaw(`/api/providers/${id}/tts-test`, {
      method: 'POST',
      json: { model, text },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string; error?: string };
      throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
    }
    return res.blob();
  },

  // ── Embed model pool ────────────────────────────────────────────────────────

  async listEmbedModels(id: string): Promise<EmbedModelsListWire> {
    return sidecarClient.request<EmbedModelsListWire>(`/api/providers/${id}/embed-models`);
  },

  // dim is optional: the server probes the real dimension at enable time and
  // only uses a supplied dim as a fallback when the probe fails.
  async enableEmbedModel(id: string, model: string, dim?: number, dimSource?: 'live' | 'table' | 'manual'): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}/embed-models/${encodeURIComponent(model)}`, {
      method: 'PUT',
      json: { dim, dimSource },
    });
  },

  async disableEmbedModel(id: string, model: string): Promise<{ ok: boolean; cascadedBindings: number }> {
    return sidecarClient.request<{ ok: boolean; cascadedBindings: number }>(
      `/api/providers/${id}/embed-models/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
  },

  // ── Rerank model pool ───────────────────────────────────────────────────────

  async listRerankModels(id: string): Promise<RerankModelsListWire> {
    return sidecarClient.request<RerankModelsListWire>(`/api/providers/${id}/rerank-models`);
  },

  async enableRerankModel(id: string, model: string, maxChunks?: number): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}/rerank-models/${encodeURIComponent(model)}`, {
      method: 'PUT',
      json: { maxChunks },
    });
  },

  async disableRerankModel(id: string, model: string): Promise<{ ok: boolean; cascadedBindings: number }> {
    return sidecarClient.request<{ ok: boolean; cascadedBindings: number }>(
      `/api/providers/${id}/rerank-models/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
  },

  // ── TTS model pool ──────────────────────────────────────────────────────────

  async listTtsModels(id: string): Promise<SimpleModelsListWire> {
    return sidecarClient.request<SimpleModelsListWire>(`/api/providers/${id}/tts-models`);
  },

  async enableTtsModel(id: string, model: string): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}/tts-models/${encodeURIComponent(model)}`, {
      method: 'PUT',
      json: {},
    });
  },

  async disableTtsModel(id: string, model: string): Promise<{ ok: boolean; cascadedBindings: number }> {
    return sidecarClient.request<{ ok: boolean; cascadedBindings: number }>(
      `/api/providers/${id}/tts-models/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
  },

  // ── STT model pool ──────────────────────────────────────────────────────────

  async listSttModels(id: string): Promise<SimpleModelsListWire> {
    return sidecarClient.request<SimpleModelsListWire>(`/api/providers/${id}/stt-models`);
  },

  async enableSttModel(id: string, model: string): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}/stt-models/${encodeURIComponent(model)}`, {
      method: 'PUT',
      json: {},
    });
  },

  async disableSttModel(id: string, model: string): Promise<{ ok: boolean; cascadedBindings: number }> {
    return sidecarClient.request<{ ok: boolean; cascadedBindings: number }>(
      `/api/providers/${id}/stt-models/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
  },

  // ── Vision model pool ───────────────────────────────────────────────────────

  async listVisionModels(id: string): Promise<SimpleModelsListWire> {
    return sidecarClient.request<SimpleModelsListWire>(`/api/providers/${id}/vision-models`);
  },

  async enableVisionModel(id: string, model: string): Promise<void> {
    await sidecarClient.request(`/api/providers/${id}/vision-models/${encodeURIComponent(model)}`, {
      method: 'PUT',
      json: {},
    });
  },

  async disableVisionModel(id: string, model: string): Promise<{ ok: boolean; cascadedBindings: number }> {
    return sidecarClient.request<{ ok: boolean; cascadedBindings: number }>(
      `/api/providers/${id}/vision-models/${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    );
  },
};
