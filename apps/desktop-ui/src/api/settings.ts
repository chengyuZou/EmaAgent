/**
 * 读写事件展示、权限超时、主题和知识库模型等通用设置。
 */
import { sidecarClient } from './sidecar-client.js';
import type {
  ContentFontPreset,
  ThemeSettings,
} from '@ema-agent/theme';

export type { ContentFontPreset } from '@ema-agent/theme';

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

export type ThemeConfig = ThemeSettings;

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
  async putEventDisplay(
    payload: Record<string, EventDisplayConfig>,
  ): Promise<EventDisplayResult> {
    return sidecarClient.request<EventDisplayResult>('/api/settings/event-display', {
      method: 'PUT',
      json: payload,
    });
  },

  /** GET /api/settings/permission-timeout */
  async getPermissionTimeout(): Promise<PermissionTimeoutResult> {
    return sidecarClient.request<PermissionTimeoutResult>('/api/settings/permission-timeout');
  },

  /** PUT /api/settings/permission-timeout */
  async putPermissionTimeout(
    payload: { timeoutMs: number },
  ): Promise<PermissionTimeoutResult> {
    return sidecarClient.request<PermissionTimeoutResult>('/api/settings/permission-timeout', {
      method: 'PUT',
      json: payload,
    });
  },

  /** GET /api/settings/theme */
  async getTheme(): Promise<ThemeConfig> {
    return sidecarClient.request<ThemeConfig>('/api/settings/theme');
  },

  /** PUT /api/settings/theme */
  async putTheme(payload: ThemeConfig): Promise<ThemeConfig> {
    return sidecarClient.request<ThemeConfig>('/api/settings/theme', {
      method: 'PUT',
      json: payload,
    });
  },

  /** GET /api/settings/kb-models — KB's embed + rerank model choice. */
  async getKbModels(): Promise<KbModelsConfig> {
    return sidecarClient.request<KbModelsConfig>('/api/settings/kb-models');
  },

  /** PUT /api/settings/kb-models */
  async putKbModels(payload: KbModelsConfig): Promise<KbModelsConfig> {
    return sidecarClient.request<KbModelsConfig>('/api/settings/kb-models', {
      method: 'PUT',
      json: payload,
    });
  },
};
