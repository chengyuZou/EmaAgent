// 提供 Desktop 使用的 Session、消息历史与附件 HTTP 入口。
import { sidecarClient } from './sidecar-client.js';

import type {
  SessionAttachmentsResult,
  SessionWire,
  MessageWire,
  TurnWire,
  SessionMessagesResult,
  SessionsListResult,
  SessionsGroupedResult,
  SessionsSearchResult,
  SessionSearchItem,
  ForkResult,
  SessionMessageWindowWire,
  TurnIndexPageWire,
} from '@ema-agent/session';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';

export type {
  SessionWire, MessageWire, TurnWire, SessionMessagesResult,
  SessionsListResult, SessionsGroupedResult, SessionsSearchResult, SessionSearchItem, ForkResult,
  SessionMessageWindowWire, TurnIndexPageWire,
};

export const sessionsApi = {
  /** 创建空 Session。 */
  async create(opts?: { title?: string }): Promise<SessionWire> {
    return sidecarClient.request<SessionWire>('/api/sessions', {
      method: 'POST',
      json: opts ?? {},
    });
  },

  /** 使用游标读取 Session 平铺列表。 */
  async list(opts?: { limit?: number; cursor?: string }): Promise<SessionsListResult> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return sidecarClient.request<SessionsListResult>(`/api/sessions${qs ? `?${qs}` : ''}`);
  },

  /** 读取侧栏使用的分组 Session 列表。 */
  async listGrouped(): Promise<SessionsGroupedResult> {
    return sidecarClient.request<SessionsGroupedResult>('/api/sessions/grouped');
  },

  /** 搜索标题与消息正文。 */
  async search(opts: { q: string; limit?: number }): Promise<SessionsSearchResult> {
    const params = new URLSearchParams();
    params.set('q', opts.q);
    if (opts.limit) params.set('limit', String(opts.limit));
    return sidecarClient.request<SessionsSearchResult>(`/api/sessions/search?${params.toString()}`);
  },

  /** 局部更新 Session，并返回最新快照。 */
  async patch(
    id: string,
    patch: {
      title?: string;
      pinned?: boolean;
      groupLabel?: string | null;
      workspaceRoot?: string | null;
      executionProfile?: ExecutionProfile;
      narrativePolicy?: NarrativePolicy;
      /** 用户希望该 Session 下一轮使用的模型；null 表示恢复系统默认选择。 */
      preferredModel?: {
        providerConfigId: string;
        modelId: string;
      } | null;
    },
  ): Promise<SessionWire> {
    return sidecarClient.request<SessionWire>(`/api/sessions/${id}`, {
      method: 'PUT',
      json: patch,
    });
  },

  /** 同时读取消息与 Turn，使前端可恢复每轮统计和聚合气泡。 */
  async listMessages(
    id: string,
    opts?: { before?: number; limit?: number },
  ): Promise<SessionMessagesResult> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit ?? 100));
    const qs = params.toString();
    return sidecarClient.request<SessionMessagesResult>(`/api/sessions/${id}/messages${qs ? `?${qs}` : ''}`);
  },

  /** 读取不含消息正文的轻量 Turn 导航索引。 */
  async listTurnIndex(
    id: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<TurnIndexPageWire> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const query = params.toString();
    return sidecarClient.request<TurnIndexPageWire>(
      `/api/sessions/${encodeURIComponent(id as string)}/turn-index${query ? `?${query}` : ''}`,
    );
  },

  /** 按锚点 Turn 读取有界历史窗口，不影响当前 SSE 热尾。 */
  async listMessageWindow(
    id: string,
    opts: { anchorTurnId: string; beforeTurns?: number; afterTurns?: number },
  ): Promise<SessionMessageWindowWire> {
    const params = new URLSearchParams();
    params.set('anchorTurnId', opts.anchorTurnId as string);
    if (opts.beforeTurns !== undefined) {
      params.set('beforeTurns', String(opts.beforeTurns));
    }
    if (opts.afterTurns !== undefined) {
      params.set('afterTurns', String(opts.afterTurns));
    }
    return sidecarClient.request<SessionMessageWindowWire>(
      `/api/sessions/${encodeURIComponent(id as string)}/messages/window?${params.toString()}`,
    );
  },

  /** GET /api/sessions/:id/attachments — 当前会话的全部附件与本地文件状态。 */
  async listAttachments(id: string): Promise<SessionAttachmentsResult> {
    return sidecarClient.request<SessionAttachmentsResult>(
      `/api/sessions/${encodeURIComponent(id as string)}/attachments`,
    );
  },

  /** 复制完整 Session，或只复制到指定 Turn（含）为止。 */
  async fork(id: string, untilTurnId?: string): Promise<ForkResult> {
    return sidecarClient.request<ForkResult>(`/api/sessions/${id}/fork`, {
      method: 'POST',
      json: untilTurnId ? { untilTurnId } : {},
    });
  },

  /** 仅回滚最后一轮，供最后一条用户消息重新编辑。 */
  async rewindLastTurn(id: string, turnId: string): Promise<{ turnId: string }> {
    return sidecarClient.request<{ turnId: string }>(
      `/api/sessions/${id}/turns/${turnId}/rewind`,
      { method: 'POST' },
    );
  },

  /** 标记 Session 已查看并清除未读状态。 */
  async markViewed(id: string): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/viewed`, { method: 'POST' });
  },

  /** POST /api/sessions/:id/archive */
  async archive(id: string): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/archive`, { method: 'POST' });
  },

  /** POST /api/sessions/:id/unarchive */
  async unarchive(id: string): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/unarchive`, { method: 'POST' });
  },

  /** DELETE /api/sessions/:id */
  async delete(id: string): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}`, { method: 'DELETE' });
  },

  /** 使用标题模型生成会话标题，失败时由后端降级处理。 */
  async generateTitle(id: string): Promise<{ title: string } | null> {
    try {
      return await sidecarClient.request<{ title: string }>(`/api/sessions/${id}/title`, {
        method: 'POST',
      });
    } catch {
      return null;
    }
  },

};
