/**
 * Sessions API — session CRUD + message loading.
 */
import { sidecarClient } from './sidecar-client.js';
import type { SessionId, MessageId, MessageRole, MessageKind, MessageBlocks } from '@ema-agent/contracts';

// ── Wire-format types (match backend JSON shapes) ────────────────────────────

export interface SessionWire {
  id:               string;
  title:            string;
  characterCardId:  string;
  workspaceRoots:   string[];
  createdAt:        number;
  updatedAt:        number;
  archivedAt:       number | null;
  pinned:           boolean;
  pinnedAt:         number | null;
  groupLabel:       string | null;
  parentSessionId:  string | null;
  runningTurnCount: number;
  meta:             Record<string, unknown>;
}

export interface MessageWire {
  id:          string;
  sessionId:   string;
  turnId:      string | null;
  role:        MessageRole;
  kind:        MessageKind;
  blocks:      MessageBlocks;
  interrupted: boolean;
  createdAt:   number;
  meta:        Record<string, unknown>;
}

export interface SessionsListResult {
  sessions:   SessionWire[];
  nextCursor?: string;
}

export interface SessionsGroupedResult {
  pinned:   SessionWire[];
  byGroup:  Array<{ label: string; sessions: SessionWire[] }>;
  recent:   SessionWire[];
  archived: SessionWire[];
}

export interface ForkResult {
  sessionId:   string;
  messageCount: number;
}

// ── API object ────────────────────────────────────────────────────────────────

export const sessionsApi = {
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
    patch: { title?: string; pinned?: boolean; groupLabel?: string | null },
  ): Promise<SessionWire> {
    return sidecarClient.request<SessionWire>(`/api/sessions/${id}`, {
      method: 'PUT',
      json: patch,
    });
  },

  /** GET /api/sessions/:id/messages — load messages for a session. */
  async listMessages(
    id: SessionId,
    opts?: { before?: number; limit?: number },
  ): Promise<MessageWire[]> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit ?? 100));
    const qs = params.toString();
    return sidecarClient.request<MessageWire[]>(`/api/sessions/${id}/messages${qs ? `?${qs}` : ''}`);
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
