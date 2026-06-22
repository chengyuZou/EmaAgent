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
};
