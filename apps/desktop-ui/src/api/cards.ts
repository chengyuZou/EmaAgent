/** 角色卡、主窗口表现与参考音频的 LocalHost API。 */
import { sidecarClient } from './sidecar-client.js';
import type { CharacterCardId } from '@ema-agent/ids';
import type {
  CharacterCard,
  CharacterCardInput,
  CharacterHealth,
  CharacterHealthIssue,
  CharacterLive2dVariant,
  CharacterPortrait,
  CharacterResourceOperation,
  CharacterVoiceReference,
} from '@ema-agent/characters';
import type { Live2DModelRuntimeConfig } from '@ema-agent/live2d-react';

export type { CharacterCard, CharacterCardInput, CharacterVoiceReference };
export type { CharacterLive2dVariant, CharacterPortrait };

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

  // ── 健康与资源操作状态 ───────────────────────────────────────────────────

  /** GET /api/cards/:id/health — deep=true 用 sharp/文件头做真实媒体深检。 */
  async health(id: CharacterCardId, deep = false): Promise<CharacterHealth> {
    return sidecarClient.request<CharacterHealth>(
      `/api/cards/${id}/health${deep ? '?depth=deep' : ''}`,
    );
  },

  /** GET /api/cards/:id/resource-operation — 当前或最近一次资源操作阶段。 */
  async resourceOperation(id: CharacterCardId): Promise<CharacterResourceOperation | null> {
    const res = await sidecarClient.request<{ operation: CharacterResourceOperation | null }>(
      `/api/cards/${id}/resource-operation`,
    );
    return res.operation;
  },

  // ── 三类资源的能力句柄导入/导出/更新/删除(C3b)───────────────────────────

  async importLive2d(
    id: CharacterCardId,
    input: {
      sourceHandle: string;
      label: string;
      format: 'live2d' | 'vrm';
      entryRelativePath: string;
      runtimeConfigRelativePath?: string | null;
      position?: number;
      isPrimary?: boolean;
    },
  ): Promise<{ resource: CharacterLive2dVariant }> {
    return sidecarClient.request(`/api/cards/${id}/live2d/import`, {
      method: 'POST',
      json: input,
    });
  },

  async exportLive2d(
    id: CharacterCardId,
    resourceId: string,
    destinationHandle: string,
  ): Promise<{ destinationPath: string }> {
    return sidecarClient.request(`/api/cards/${id}/live2d/${resourceId}/export`, {
      method: 'POST',
      json: { destinationHandle },
    });
  },

  async patchLive2d(
    id: CharacterCardId,
    resourceId: string,
    patch: { label?: string; position?: number; enabled?: boolean },
  ): Promise<{ resource: CharacterLive2dVariant }> {
    return sidecarClient.request(`/api/cards/${id}/live2d/${resourceId}`, {
      method: 'PATCH',
      json: patch,
    });
  },

  async deleteLive2d(id: CharacterCardId, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/live2d/${resourceId}`, { method: 'DELETE' });
  },

  async importPortrait(
    id: CharacterCardId,
    input: { sourceHandle: string; label: string; position?: number; isPrimary?: boolean },
  ): Promise<{ resource: CharacterPortrait }> {
    return sidecarClient.request(`/api/cards/${id}/portraits/import`, {
      method: 'POST',
      json: input,
    });
  },

  async exportPortrait(
    id: CharacterCardId,
    resourceId: string,
    destinationHandle: string,
  ): Promise<{ destinationPath: string }> {
    return sidecarClient.request(`/api/cards/${id}/portraits/${resourceId}/export`, {
      method: 'POST',
      json: { destinationHandle },
    });
  },

  async patchPortrait(
    id: CharacterCardId,
    resourceId: string,
    patch: { label?: string; position?: number; enabled?: boolean },
  ): Promise<{ resource: CharacterPortrait }> {
    return sidecarClient.request(`/api/cards/${id}/portraits/${resourceId}`, {
      method: 'PATCH',
      json: patch,
    });
  },

  async deletePortrait(id: CharacterCardId, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/portraits/${resourceId}`, { method: 'DELETE' });
  },

  async exportVoiceRef(
    cardId: CharacterCardId,
    resourceId: string,
    destinationHandle: string,
  ): Promise<{ destinationPath: string }> {
    return sidecarClient.request(`/api/cards/${cardId}/voice-refs/${resourceId}/export`, {
      method: 'POST',
      json: { destinationHandle },
    });
  },

  async patchVoiceRef(
    cardId: CharacterCardId,
    resourceId: string,
    patch: { label?: string; position?: number; enabled?: boolean },
  ): Promise<{ resource: CharacterVoiceReference }> {
    return sidecarClient.request(`/api/cards/${cardId}/voice-refs/${resourceId}`, {
      method: 'PATCH',
      json: patch,
    });
  },
};
