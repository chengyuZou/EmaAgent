/**
 * Cards API — character card CRUD + voice-refs sub-resource.
 */
import { sidecarClient } from './sidecar-client.js';
import type { CharacterCardId } from '@ema-agent/contracts';
import type { CharacterVoiceProfile } from '@ema-agent/character-card';

// ── Wire-format types (match backend CharacterCard domain) ───────────────────

export interface CharacterCardWire {
  id:               CharacterCardId;
  name:             string;
  version:          string;
  description:      string | null;
  systemPrompt:     string;
  speechPatterns:   string[];
  forbiddenTopics:  string[];
  emotionVocabulary: string[];
  motionVocabulary:  string[];
  live2dModelId:    string | null;
  voiceProfile:     CharacterVoiceProfile;
  isActive:         boolean;
  isBuiltin:        boolean;
  createdAt:        number;
  updatedAt:        number;
}

export interface CharacterCardInput {
  name:              string;
  version?:          string;
  description?:      string;
  systemPrompt:      string;
  speechPatterns?:   string[];
  forbiddenTopics?:  string[];
  emotionVocabulary?: string[];
  motionVocabulary?:  string[];
  live2dModelId?:    string;
  voiceProfile?:     CharacterVoiceProfile;
}

// ── API object ────────────────────────────────────────────────────────────────

export const cardsApi = {
  /** GET /api/cards — list all cards. */
  async list(): Promise<CharacterCardWire[]> {
    return sidecarClient.request<CharacterCardWire[]>('/api/cards');
  },

  /** GET /api/cards/:id */
  async get(id: CharacterCardId): Promise<CharacterCardWire> {
    return sidecarClient.request<CharacterCardWire>(`/api/cards/${id}`);
  },

  /** POST /api/cards */
  async create(input: CharacterCardInput): Promise<CharacterCardWire> {
    return sidecarClient.request<CharacterCardWire>('/api/cards', {
      method: 'POST',
      json: input,
    });
  },

  /** PATCH /api/cards/:id */
  async patch(id: CharacterCardId, input: Partial<CharacterCardInput>): Promise<CharacterCardWire> {
    return sidecarClient.request<CharacterCardWire>(`/api/cards/${id}`, {
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

  // ── Voice-refs ──────────────────────────────────────────────────────────

  /** GET /api/cards/:cardId/voice-refs */
  async listVoiceRefs(cardId: CharacterCardId): Promise<CharacterVoiceProfile> {
    return sidecarClient.request<CharacterVoiceProfile>(`/api/cards/${cardId}/voice-refs`);
  },

  /** POST /api/cards/:cardId/voice-refs — multipart upload */
  async uploadVoiceRef(
    cardId: CharacterCardId,
    file: Blob,
    meta: { label: string; promptText: string; promptLang: string; setPrimary?: boolean },
  ): Promise<{ ref: { id: string; label: string; refAudioPath: string; promptText: string; promptLang: string }; primaryId: string | null }> {
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
