/** 角色卡、主窗口表现与参考音频的 LocalHost API。 */
import { sidecarClient } from './sidecar-client.js';

import type {
  CharacterCard,
  CharacterCardInput,
  CharacterHealth,
  CharacterHealthIssue,
  CharacterLive2dVariant,
  CharacterIllustration,
  CharacterResourceOperation,
  CharacterVoiceReference,
} from '@ema-agent/characters';
import type {
  Live2DModelConfig,
  Live2DMotionTarget,
} from '@ema-agent/live2d-react';

export type { CharacterCard, CharacterCardInput, CharacterVoiceReference };
export type { CharacterLive2dVariant, CharacterIllustration };

export interface CharacterLive2dStageTarget {
  expression?: string;
  motion?: Live2DMotionTarget;
}

/** 角色资源文件的完整配置；Live2D 包只消费模型参数和待机动作部分。 */
export interface CharacterLive2dRuntimeConfig extends Live2DModelConfig {
  emotionMap?: Record<string, CharacterLive2dStageTarget>;
  motionMap?: Record<string, Live2DMotionTarget>;
}

interface CharacterStageResource {
  resourceId: string;
  name: string;
  resourceRevision: string;
  sourcePath: string;
  stageScale: number;
  stageOffsetX: number;
  stageOffsetY: number;
}

export type CharacterStageCandidate =
  | CharacterStageResource & {
      kind: 'live2d';
      runtimeConfig: CharacterLive2dRuntimeConfig | null;
    }
  | CharacterStageResource & {
      kind: 'illustration';
    };

export interface CharacterStageSnapshot {
  characterId: string;
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
  async get(id: string): Promise<CharacterCard> {
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
  async patch(id: string, input: Partial<CharacterCardInput>): Promise<CharacterCard> {
    return sidecarClient.request<CharacterCard>(`/api/cards/${id}`, {
      method: 'PATCH',
      json: input,
    });
  },

  /** DELETE /api/cards/:id */
  async delete(id: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}`, { method: 'DELETE' });
  },

  /** PUT /api/cards/:id/activate */
  async activate(id: string): Promise<{ activeCardId: string }> {
    return sidecarClient.request<{ activeCardId: string }>(`/api/cards/${id}/activate`, {
      method: 'PUT',
    });
  },

  // ── 主窗口表现 ───────────────────────────────────────────────────────────

  /** 返回已经按 Live2D → 立绘冻结顺序排列的主窗口候选。 */
  async getPresentation(id: string): Promise<CharacterStageSnapshot> {
    return sidecarClient.request<CharacterStageSnapshot>(`/api/cards/${id}/presentation`);
  },

  async setPrimaryLive2d(id: string, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/live2d/primary`, {
      method: 'PUT',
      json: { resourceId },
    });
  },

  async setPrimaryIllustration(id: string, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/illustration/primary`, {
      method: 'PUT',
      json: { resourceId },
    });
  },

  // ── 参考音频 ────────────────────────────────────────────────────────────

  /** GET /api/cards/:cardId/voice */
  async listVoiceReferences(cardId: string): Promise<CharacterVoiceReference[]> {
    return sidecarClient.request<CharacterVoiceReference[]>(`/api/cards/${cardId}/voice`);
  },

  /** POST /api/cards/:cardId/voice — multipart upload */
  async uploadVoiceReference(
    cardId: string,
    file: Blob,
    meta: { name: string; promptText: string; promptLang: string; setPrimary?: boolean },
  ): Promise<{ reference: CharacterVoiceReference; primaryId: string | null }> {
    const form = new FormData();
    form.set('file', file);
    form.set('name', meta.name);
    form.set('promptText', meta.promptText);
    form.set('promptLang', meta.promptLang);
    if (meta.setPrimary) form.set('setPrimary', 'true');

    return sidecarClient.request(`/api/cards/${cardId}/voice`, {
      method: 'POST',
      body: form,
    });
  },

  /** GET /api/cards/:cardId/voice/:refId — download audio blob */
  async downloadVoiceReference(cardId: string, refId: string): Promise<Blob> {
    const res = await sidecarClient.requestRaw(`/api/cards/${cardId}/voice/${refId}`);
    return res.blob();
  },

  /** DELETE /api/cards/:cardId/voice/:refId */
  async deleteVoiceReference(cardId: string, refId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${cardId}/voice/${refId}`, { method: 'DELETE' });
  },

  /** PUT /api/cards/:cardId/voice/primary */
  async setPrimaryVoiceReference(cardId: string, refId: string): Promise<{ primaryId: string }> {
    return sidecarClient.request<{ primaryId: string }>(`/api/cards/${cardId}/voice/primary`, {
      method: 'PUT',
      json: { refId },
    });
  },

  // ── 健康与资源操作状态 ───────────────────────────────────────────────────

  /** GET /api/cards/:id/health — deep=true 用 sharp/文件头做真实媒体深检。 */
  async health(id: string, deep = false): Promise<CharacterHealth> {
    return sidecarClient.request<CharacterHealth>(
      `/api/cards/${id}/health${deep ? '?depth=deep' : ''}`,
    );
  },

  /** GET /api/cards/:id/resource-operation — 当前或最近一次资源操作阶段。 */
  async resourceOperation(id: string): Promise<CharacterResourceOperation | null> {
    const res = await sidecarClient.request<{ operation: CharacterResourceOperation | null }>(
      `/api/cards/${id}/resource-operation`,
    );
    return res.operation;
  },

  // ── 三类资源的能力句柄导入/导出/更新/删除(C3b)───────────────────────────

  async importLive2d(
    id: string,
    input: {
      sourceHandle: string;
      name: string;
      isPrimary?: boolean;
    },
  ): Promise<{ resource: CharacterLive2dVariant }> {
    return sidecarClient.request(`/api/cards/${id}/live2d/import`, {
      method: 'POST',
      json: input,
    });
  },

  async exportLive2d(
    id: string,
    resourceId: string,
    destinationHandle: string,
  ): Promise<{ destinationPath: string }> {
    return sidecarClient.request(`/api/cards/${id}/live2d/${resourceId}/export`, {
      method: 'POST',
      json: { destinationHandle },
    });
  },

  async patchLive2d(
    id: string,
    resourceId: string,
    patch: {
      name?: string;
      stageScale?: number;
      stageOffsetX?: number;
      stageOffsetY?: number;
      enabled?: boolean;
    },
  ): Promise<{ resource: CharacterLive2dVariant }> {
    return sidecarClient.request(`/api/cards/${id}/live2d/${resourceId}`, {
      method: 'PATCH',
      json: patch,
    });
  },

  async deleteLive2d(id: string, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/live2d/${resourceId}`, { method: 'DELETE' });
  },

  async importIllustration(
    id: string,
    input: { sourceHandle: string; name: string; isPrimary?: boolean },
  ): Promise<{ resource: CharacterIllustration }> {
    return sidecarClient.request(`/api/cards/${id}/illustration/import`, {
      method: 'POST',
      json: input,
    });
  },

  async exportIllustration(
    id: string,
    resourceId: string,
    destinationHandle: string,
  ): Promise<{ destinationPath: string }> {
    return sidecarClient.request(`/api/cards/${id}/illustration/${resourceId}/export`, {
      method: 'POST',
      json: { destinationHandle },
    });
  },

  async patchIllustration(
    id: string,
    resourceId: string,
    patch: {
      name?: string;
      stageScale?: number;
      stageOffsetX?: number;
      stageOffsetY?: number;
      enabled?: boolean;
    },
  ): Promise<{ resource: CharacterIllustration }> {
    return sidecarClient.request(`/api/cards/${id}/illustration/${resourceId}`, {
      method: 'PATCH',
      json: patch,
    });
  },

  async deleteIllustration(id: string, resourceId: string): Promise<void> {
    await sidecarClient.request(`/api/cards/${id}/illustration/${resourceId}`, { method: 'DELETE' });
  },

  async exportVoiceReference(
    cardId: string,
    resourceId: string,
    destinationHandle: string,
  ): Promise<{ destinationPath: string }> {
    return sidecarClient.request(`/api/cards/${cardId}/voice/${resourceId}/export`, {
      method: 'POST',
      json: { destinationHandle },
    });
  },

  async patchVoiceReference(
    cardId: string,
    resourceId: string,
    patch: { name?: string; enabled?: boolean },
  ): Promise<{ resource: CharacterVoiceReference }> {
    return sidecarClient.request(`/api/cards/${cardId}/voice/${resourceId}`, {
      method: 'PATCH',
      json: patch,
    });
  },
};
