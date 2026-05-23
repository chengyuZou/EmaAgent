/**
 * Settings API — event-display / permission-timeout / tts-fallback KV.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire-format types ────────────────────────────────────────────────────────

export interface EventDisplayConfig {
  enabled:        boolean;
  color:          string;
  durationMs:     number | null;
  truncateChars?: number;
}

export interface EventDisplayResult {
  defaults:  Record<string, EventDisplayConfig>;
  overrides: Record<string, EventDisplayConfig>;
  effective: Record<string, EventDisplayConfig>;
}

export interface PermissionTimeoutResult {
  timeoutMs: number;
}

export interface TtsFallbackSettings {
  providerConfigId: string;
  model:            string;
  voiceId:          string | null;
  config?:          Record<string, unknown>;
}

// ── API object ────────────────────────────────────────────────────────────────

export const settingsApi = {
  /** GET /api/settings/event-display */
  async getEventDisplay(): Promise<EventDisplayResult> {
    return sidecarClient.request<EventDisplayResult>('/api/settings/event-display');
  },

  /** PUT /api/settings/event-display */
  async putEventDisplay(payload: Record<string, EventDisplayConfig>): Promise<void> {
    await sidecarClient.request('/api/settings/event-display', {
      method: 'PUT',
      json: payload,
    });
  },

  /** GET /api/settings/permission-timeout */
  async getPermissionTimeout(): Promise<PermissionTimeoutResult> {
    return sidecarClient.request<PermissionTimeoutResult>('/api/settings/permission-timeout');
  },

  /** PUT /api/settings/permission-timeout */
  async putPermissionTimeout(payload: { timeoutMs: number }): Promise<void> {
    await sidecarClient.request('/api/settings/permission-timeout', {
      method: 'PUT',
      json: payload,
    });
  },

  /** GET /api/settings/tts-fallback */
  async getTtsFallback(): Promise<{ fallback: TtsFallbackSettings | null }> {
    return sidecarClient.request<{ fallback: TtsFallbackSettings | null }>('/api/settings/tts-fallback');
  },

  /** PUT /api/settings/tts-fallback */
  async putTtsFallback(payload: TtsFallbackSettings): Promise<void> {
    await sidecarClient.request('/api/settings/tts-fallback', {
      method: 'PUT',
      json: payload,
    });
  },

  /** DELETE /api/settings/tts-fallback */
  async deleteTtsFallback(): Promise<void> {
    await sidecarClient.request('/api/settings/tts-fallback', { method: 'DELETE' });
  },
};
