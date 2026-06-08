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
};
