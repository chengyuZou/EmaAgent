/**
 * Model Bindings API — per-module LLM/TTS/STT binding CRUD.
 * Types imported from @ema-agent/storage.
 */
import { sidecarClient } from './sidecar-client.js';
import type { BindingModule, ResolvedModelBinding } from '@ema-agent/storage';

export type { BindingModule, ResolvedModelBinding };

export interface BindingUpsertInput {
  providerConfigId: string;
  model:            string;
  voiceId?:         string;
  config?:          Record<string, unknown>;
}

export interface BindingUpsertInput {
  providerConfigId: string;
  model:            string;
  voiceId?:         string;
  config?:          Record<string, unknown>;
}

// ── API object ────────────────────────────────────────────────────────────────

export interface AvailableBindingModel {
  providerConfigId: string;
  providerName:     string;
  model:            string;
  contextWindow:    number;
  dim?:             number;
  maxChunks?:       number;
}

export const modelBindingsApi = {
  /** GET /api/model-bindings — all modules' bindings. */
  async list(): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>('/api/model-bindings');
  },

  /**
   * GET /api/model-bindings/available/:capability — the enabled-model pool the
   * picker chooses from (provider-enabled models). Only 'llm' is populated today.
   */
  async listAvailable(capability: string): Promise<AvailableBindingModel[]> {
    const res = await sidecarClient.request<{ models: AvailableBindingModel[] }>(
      `/api/model-bindings/available/${capability}`,
    );
    return res.models;
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

  /**
   * PUT /api/model-bindings/:module/set — atomic single-select: wipes all
   * existing bindings for the module, then sets the one given model.
   */
  async set(
    module: BindingModule,
    input: BindingUpsertInput,
  ): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>(
      `/api/model-bindings/${module}/set`,
      { method: 'PUT', json: input },
    );
  },
};
