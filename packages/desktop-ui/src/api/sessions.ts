/**
 * Sessions API — session CRUD + message loading.
 *
 * Wire types live in @ema-agent/contracts (single source of truth shared with
 * apps/core routes). Re-exported here so existing consumers keep working.
 */
import { sidecarClient } from './sidecar-client.js';
import type {
  SessionId,
  TurnMode,
  AgentSubMode,
  SessionWire,
  MessageWire,
  TurnWire,
  SessionMessagesResult,
  SessionsListResult,
  SessionsGroupedResult,
  ForkResult,
} from '@ema-agent/contracts';

export type {
  SessionWire, MessageWire, TurnWire, SessionMessagesResult,
  SessionsListResult, SessionsGroupedResult, ForkResult,
};

// ── API object ────────────────────────────────────────────────────────────────

export const sessionsApi = {
  /** POST /api/sessions — create a new empty session. */
  async create(opts?: { title?: string; characterCardId?: string }): Promise<SessionWire> {
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

  /** PUT /api/sessions/:id — partial update. Returns updated session. */
  async patch(
    id: SessionId,
    patch: {
      title?: string;
      pinned?: boolean;
      groupLabel?: string | null;
      workspaceRoots?: string[];
      lastMode?: TurnMode | null;
      lastSubMode?: AgentSubMode | null;
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

  /** POST /api/sessions/:id/fork — fork a session. */
  async fork(id: SessionId): Promise<ForkResult> {
    return sidecarClient.request<ForkResult>(`/api/sessions/${id}/fork`, { method: 'POST' });
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
};
