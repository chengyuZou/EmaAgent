/**
 * Providers API — CRUD + definitions + health probe.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire-format types ────────────────────────────────────────────────────────

export interface ProviderDefinitionWire {
  id:                  string;
  name:                string;
  defaultBaseUrl?:     string;
  /** Per-protocol base URLs, e.g. { 'openai-llm': '...', 'anthropic-llm': '...' } */
  protocolBaseUrls?:   Record<string, string>;
  capabilities:        string[];
  /** Each capability maps to a protocol or array of protocols. */
  protocols:           Record<string, string | string[]>;
  defaultModels?:      Record<string, string[]>;
  iconKey?:            string;
  iconColor?:          string;
  requiresCredentials: boolean;
  onboardingFields?:   Array<{
    key: string;
    type: string;
    label: string;
    description?: string;
    placeholder?: string;
    required?: boolean;
    defaultValue?: string;
  }>;
}

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
  definition:   ProviderDefinitionWire | null;
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
  async listDefinitions(): Promise<ProviderDefinitionWire[]> {
    return sidecarClient.request<ProviderDefinitionWire[]>('/api/providers/definitions');
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
