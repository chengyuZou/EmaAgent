import { sidecarClient } from './sidecar-client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnabledModelWire {
  providerId:      string;
  providerName:    string;
  model:           string;
  contextWindow:   number;
  contextSource:   string;
  definitionId:    string;
}

// ── API object ────────────────────────────────────────────────────────────────

export const modelsApi = {
  /** GET /api/providers/models — all enabled LLM models across all providers. */
  async listEnabled(): Promise<EnabledModelWire[]> {
    return sidecarClient.request<EnabledModelWire[]>('/api/providers/models');
  },
};
