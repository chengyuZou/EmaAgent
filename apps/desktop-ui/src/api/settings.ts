/**
 * Settings API — event-display / permission-timeout KV.
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

export interface ThemeConfig {
  hue:    number;
  radius: number;
  /** 'light'(默认)| 'dark'。暗色 token 在 :root,亮色 [data-theme="light"] 覆盖 */
  mode?:  'light' | 'dark';
}

/** KB's own embed/rerank model choice (decoupled from LightRAG's lightrag-embed binding). */
export interface KbModelRef { providerConfigId: string; model: string }
export interface KbModelsConfig { embed?: KbModelRef | null; rerank?: KbModelRef | null }

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

  /** GET /api/settings/theme */
  async getTheme(): Promise<ThemeConfig> {
    return sidecarClient.request<ThemeConfig>('/api/settings/theme');
  },

  /** PUT /api/settings/theme */
  async putTheme(payload: ThemeConfig): Promise<void> {
    await sidecarClient.request('/api/settings/theme', {
      method: 'PUT',
      json: payload,
    });
  },

  /** GET /api/settings/kb-models — KB's embed + rerank model choice. */
  async getKbModels(): Promise<KbModelsConfig> {
    return sidecarClient.request<KbModelsConfig>('/api/settings/kb-models');
  },

  /** PUT /api/settings/kb-models */
  async putKbModels(payload: KbModelsConfig): Promise<void> {
    await sidecarClient.request('/api/settings/kb-models', {
      method: 'PUT',
      json: payload,
    });
  },
};
