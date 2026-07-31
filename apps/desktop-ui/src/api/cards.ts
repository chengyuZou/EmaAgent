/** 角色卡、主窗口表现与参考音频的 LocalHost API。 */
import { sidecarClient } from './sidecar-client.js';
import type { CharacterCardId } from '@ema-agent/ids';
import type {
  CharacterCard,
  CharacterCardInput,
  CharacterHealthIssue,
  CharacterVoiceReference,
} from '@ema-agent/characters';
import type { Live2DModelRuntimeConfig } from '@ema-agent/live2d-react';

export type { CharacterCard, CharacterCardInput, CharacterVoiceReference };

export type CharacterStageCandidate =
  | {
      kind: 'live2d';
      resourceId: string;
      label: string;
      resourceRevision: string;
      sourcePath: string;
      runtimeConfig: Live2DModelRuntimeConfig | null;
    }
  | {
      kind: 'portrait';
      resourceId: string;
      label: string;
      resourceRevision: string;
      sourcePath: string;
      mimeType: string;
      width: number;
      height: number;
    };

export interface CharacterStageSnapshot {
  characterId: CharacterCardId;
  revision: string;
  candidates: CharacterStageCandidate[];
  issues: CharacterHealthIssue[];
}

// ── API ─────────────────────────────────────────────────────────────────────

export const cardsApi = {
  /** GET /api/cards — list all cards. */
  async list(): Promise<CharacterCard[]> {
    return sidecarClient.request<CharacterCard[]>('/api/cards');
  },

  /** GET /api/cards/:id */
  async get(id: CharacterCardId): Promise<CharacterCard> {
    return sidecarClient.request<CharacterCard>(`/api/cards/${id}`);
  },

  /** POST /api/cards */
  async create(input: CharacterCardInput): Promise<CharacterCard> {
    return sidecarClient.request<CharacterCard>('/api/cards', {
      method: 'POST',
      json: input,
    });
  },

  /** PATCH /api/cards/:id */
  async patch(id: CharacterCardId, input: Partial<CharacterCardInput>): Promise<CharacterCard> {
    return sidecarClient.request<CharacterCard>(`/api/cards/${id}`, {
      method: 'PATCH',
      json: input,
    });
  },

  /** DELETE /api/cards/:id */
  async delete(id: CharacterCardId): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}`, { method: 'DELETE' });
  },

  /** PUT /api/cards/:id/activate */
  async activate(id: CharacterCardId): Promise<{ activeCardId: string }> {
    return sidecarClient.request<{ activeCardId: string }>(`/api/cards/${id}/activate`, {
      method: 'PUT',
    });
  },

  // ── 主窗口表现 ───────────────────────────────────────────────────────────

  /** 返回已经按 Live2D → 立绘冻结顺序排列的主窗口候选。 */
  async getPresentation(id: CharacterCardId): Promise<CharacterStageSnapshot> {
    return sidecarClient.request<CharacterStageSnapshot>(`/api/cards/${id}/presentation`);
  },

  async setPrimaryLive2d(id: CharacterCardId, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/live2d/primary`, {
      method: 'PUT',
      json: { resourceId },
    });
  },

  async setPrimaryPortrait(id: CharacterCardId, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/portraits/primary`, {
      method: 'PUT',
      json: { resourceId },
    });
  },

  // ── Voice-refs ──────────────────────────────────────────────────────────

  /** GET /api/cards/:cardId/voice-refs */
  async listVoiceRefs(cardId: CharacterCardId): Promise<CharacterVoiceReference[]> {
    return sidecarClient.request<CharacterVoiceReference[]>(`/api/cards/${cardId}/voice-refs`);
  },

  /** POST /api/cards/:cardId/voice-refs — multipart upload */
  async uploadVoiceRef(
    cardId: CharacterCardId,
    file: Blob,
    meta: { label: string; promptText: string; promptLang: string; setPrimary?: boolean },
  ): Promise<{ reference: CharacterVoiceReference; primaryId: string | null }> {
    const form = new FormData();
    form.set('file', file);
    form.set('label', meta.label);
    form.set('promptText', meta.promptText);
    form.set('promptLang', meta.promptLang);
    if (meta.setPrimary) form.set('setPrimary', 'true');

    return sidecarClient.request(`/api/cards/${cardId}/voice-refs`, {
      method: 'POST',
      body: form,
    });
  },

  /** GET /api/cards/:cardId/voice-refs/:refId — download audio blob */
  async downloadVoiceRef(cardId: CharacterCardId, refId: string): Promise<Blob> {
    const res = await sidecarClient.requestRaw(`/api/cards/${cardId}/voice-refs/${refId}`);
    return res.blob();
  },

  /** DELETE /api/cards/:cardId/voice-refs/:refId */
  async deleteVoiceRef(cardId: CharacterCardId, refId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${cardId}/voice-refs/${refId}`, { method: 'DELETE' });
  },

  /** PUT /api/cards/:cardId/voice-refs/primary */
  async setPrimaryVoiceRef(cardId: CharacterCardId, refId: string): Promise<{ primaryId: string }> {
    return sidecarClient.request<{ primaryId: string }>(`/api/cards/${cardId}/voice-refs/primary`, {
      method: 'PUT',
      json: { refId },
    });
  },
};
