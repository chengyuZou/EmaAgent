/**
 * Model Bindings API — per-module LLM/TTS/STT binding CRUD.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire-format types ────────────────────────────────────────────────────────

/** Keep in sync with backend `BindingModule` + CHECK constraint. */
export type BindingModule =
  | 'chat' | 'narrative' | 'agent'
  | 'compaction' | 'emotion' | 'memory'
  | 'router' | 'plan-parse' | 'title'
  | 'embed' | 'rerank' | 'lightrag-llm'
  | 'tts_chat' | 'tts_narrative' | 'tts_agent'
  | 'stt' | 'vision' | 'imagegen';

export interface ResolvedModelBinding {
  module:           BindingModule;
  providerConfigId: string;
  model:            string;
  voiceId?:         string | null;
  config?:          Record<string, unknown>;
}

export interface BindingUpsertInput {
  providerConfigId: string;
  model:            string;
  voiceId?:         string;
  config?:          Record<string, unknown>;
}

// ── API object ────────────────────────────────────────────────────────────────

export const modelBindingsApi = {
  /** GET /api/model-bindings — all modules' bindings. */
  async list(): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>('/api/model-bindings');
  },

  /** GET /api/model-bindings/:module */
  async listByModule(module: BindingModule): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>(`/api/model-bindings/${module}`);
  },

  /** PUT /api/model-bindings/:module — upsert one binding. Returns updated module list. */
  async upsert(
    module: BindingModule,
    input: BindingUpsertInput,
  ): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>(`/api/model-bindings/${module}`, {
      method: 'PUT',
      json: input,
    });
  },

  /** DELETE /api/model-bindings/:module?providerConfigId=...&model=... */
  async delete(
    module: BindingModule,
    providerConfigId: string,
    model: string,
  ): Promise<void> {
    const params = new URLSearchParams({ providerConfigId, model });
    await sidecarClient.request(`/api/model-bindings/${module}?${params}`, {
      method: 'DELETE',
    });
  },
};
