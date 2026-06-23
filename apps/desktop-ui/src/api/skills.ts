/**
 * Skills API — skill lifecycle management.
 */
import { sidecarClient } from './sidecar-client.js';
import type { SkillRecord } from '@ema-agent/skill';

// File-backed model: records are metadata (no body). Body is read lazily on
// activation server-side; the UI never receives it.
export type { SkillRecord };

export interface SkillValidateResult {
  valid:   boolean;
  errors:  string[];
  name?:   string;
  version?: string;
}

export interface MarketSkillEntry {
  name:        string;
  version:     string;
  description?: string;
  /** Raw file URL (GitHub raw / jsDelivr) ready for installFromUrl. */
  url:         string;
  /** SHA-256 checksum (hex) for integrity verification, if provided. */
  sha256?:     string;
  author?:     string;
  tags?:       string[];
  sizeBytes?:  number;
}

export interface MarketListResult {
  source: string;
  skills: MarketSkillEntry[];
}

export const skillsApi = {
  /** GET /api/skills */
  async list(): Promise<{ skills: SkillRecord[] }> {
    return sidecarClient.request<{ skills: SkillRecord[] }>('/api/skills');
  },

  /** GET /api/skills/:name */
  async get(name: string): Promise<{ skill: SkillRecord }> {
    return sidecarClient.request<{ skill: SkillRecord }>(`/api/skills/${name}`);
  },

  /** POST /api/skills — install from text content */
  async installFromText(content: string): Promise<{ skill: SkillRecord }> {
    return sidecarClient.request<{ skill: SkillRecord }>('/api/skills', {
      method: 'POST',
      json: { source: 'text', content },
    });
  },

  /** POST /api/skills — install from URL */
  async installFromUrl(url: string): Promise<{ skill: SkillRecord }> {
    return sidecarClient.request<{ skill: SkillRecord }>('/api/skills', {
      method: 'POST',
      json: { source: 'url', url },
    });
  },

  /** POST /api/skills/validate */
  async validate(content: string): Promise<SkillValidateResult> {
    return sidecarClient.request<SkillValidateResult>('/api/skills/validate', {
      method: 'POST',
      json: { content },
    });
  },

  /** PATCH /api/skills/:name */
  async setEnabled(name: string, enabled: boolean): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/skills/${name}`, {
      method: 'PATCH',
      json: { enabled },
    });
  },

  /** DELETE /api/skills/:name */
  async remove(name: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/skills/${name}`, {
      method: 'DELETE',
    });
  },

  /**
   * GET /api/skills/market — list installable skills from a market.
   * - Default (no args): Anthropic official skill market.
   * - `marketId`: named market registered on the server.
   * - `owner`+`repo`+`ref`: ad-hoc GitHub repository.
   */
  async listMarket(opts: {
    marketId?: string;
    owner?:    string;
    repo?:     string;
    ref?:      string;
  } = {}): Promise<MarketListResult> {
    const params = new URLSearchParams();
    if (opts.marketId) params.set('market', opts.marketId);
    if (opts.owner)    params.set('owner',  opts.owner);
    if (opts.repo)     params.set('repo',   opts.repo);
    if (opts.ref)      params.set('ref',    opts.ref);
    const qs = params.toString();
    return sidecarClient.request<MarketListResult>(`/api/skills/market${qs ? `?${qs}` : ''}`);
  },

  /** POST /api/skills/:name/rename */
  async rename(name: string, newName: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/skills/${name}/rename`, {
      method: 'POST',
      json:   { newName },
    });
  },
};
