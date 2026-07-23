/**
 * Sessions API — session CRUD + message loading.
 *
 * Wire types由 @ema-agent/session 统一定义，Core 与 Desktop 不各自复制。
 * 本模块继续转出类型，保持 Desktop 内部调用入口稳定。
 */
import { sidecarClient } from './sidecar-client.js';
import type { SessionId, TurnId } from '@ema-agent/ids';
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
} from '@ema-agent/session';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';

export type {
  SessionWire, MessageWire, TurnWire, SessionMessagesResult,
  SessionsListResult, SessionsGroupedResult, SessionsSearchResult, SessionSearchItem, ForkResult,
};

// ── API object ────────────────────────────────────────────────────────────────

export const sessionsApi = {
  /** POST /api/sessions — create a new empty session. */
  async create(opts?: { title?: string }): Promise<SessionWire> {
    return sidecarClient.request<SessionWire>('/api/sessions', {
      method: 'POST',
      json: opts ?? {},
    });
  },

  /** GET /api/sessions — cursor-paginated flat list. */
  async list(opts?: { limit?: number; cursor?: string }): Promise<SessionsListResult> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return sidecarClient.request<SessionsListResult>(`/api/sessions${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/sessions/grouped — sidebar-ready grouped listing. */
  async listGrouped(): Promise<SessionsGroupedResult> {
    return sidecarClient.request<SessionsGroupedResult>('/api/sessions/grouped');
  },

  /** GET /api/sessions/search?q=... — search titles + message text. */
  async search(opts: { q: string; limit?: number }): Promise<SessionsSearchResult> {
    const params = new URLSearchParams();
    params.set('q', opts.q);
    if (opts.limit) params.set('limit', String(opts.limit));
    return sidecarClient.request<SessionsSearchResult>(`/api/sessions/search?${params.toString()}`);
  },

  /** PUT /api/sessions/:id — partial update. Returns updated session. */
  async patch(
    id: SessionId,
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

  /**
   * GET /api/sessions/:id/messages — load messages + their turns.
   * Turns ride along so the store can group messages by turnId and attach
   * per-turn usage / duration / replayable audio (see SessionMessagesResult).
   */
  async listMessages(
    id: SessionId,
    opts?: { before?: number; limit?: number },
  ): Promise<SessionMessagesResult> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit ?? 100));
    const qs = params.toString();
    return sidecarClient.request<SessionMessagesResult>(`/api/sessions/${id}/messages${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/sessions/:id/attachments — 当前会话的全部附件与本地文件状态。 */
  async listAttachments(id: SessionId): Promise<SessionAttachmentsResult> {
    return sidecarClient.request<SessionAttachmentsResult>(
      `/api/sessions/${encodeURIComponent(id as string)}/attachments`,
    );
  },

  /** 复制完整 Session，或只复制到指定 Turn（含）为止。 */
  async fork(id: SessionId, untilTurnId?: TurnId): Promise<ForkResult> {
    return sidecarClient.request<ForkResult>(`/api/sessions/${id}/fork`, {
      method: 'POST',
      json: untilTurnId ? { untilTurnId } : {},
    });
  },

  /** 仅回滚最后一轮，供最后一条用户消息重新编辑。 */
  async rewindLastTurn(id: SessionId, turnId: TurnId): Promise<{ turnId: TurnId }> {
    return sidecarClient.request<{ turnId: TurnId }>(
      `/api/sessions/${id}/turns/${turnId}/rewind`,
      { method: 'POST' },
    );
  },

  /** POST /api/sessions/:id/viewed — reset hasUnread for this session. Fire-and-forget. */
  async markViewed(id: SessionId): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/viewed`, { method: 'POST' });
  },

  /** POST /api/sessions/:id/archive */
  async archive(id: SessionId): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/archive`, { method: 'POST' });
  },

  /** POST /api/sessions/:id/unarchive */
  async unarchive(id: SessionId): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/unarchive`, { method: 'POST' });
  },

  /** DELETE /api/sessions/:id */
  async delete(id: SessionId): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}`, { method: 'DELETE' });
  },

  /**
   * POST /api/sessions/:id/title — generate a title for the session using the
   * 'title' LLM binding (falls back to truncating the first user message).
   * Fire-and-forget from the caller's perspective.
   */
  async generateTitle(id: SessionId): Promise<{ title: string } | null> {
    try {
      return await sidecarClient.request<{ title: string }>(`/api/sessions/${id}/title`, {
        method: 'POST',
      });
    } catch {
      return null;
    }
  },

};
