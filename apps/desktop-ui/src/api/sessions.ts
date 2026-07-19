/**
 * Sessions API — session CRUD + message loading.
 *
 * Wire types live in @ema-agent/contracts (single source of truth shared with
 * apps/core routes). Re-exported here so existing consumers keep working.
 *
 * BranchWire is local to this layer (not in contracts) — it's only consumed by
 * the desktop-ui BranchPanel and has no cross-package users.
 */
import { sidecarClient } from './sidecar-client.js';
import type {
  SessionId,
  TurnId,
  BranchId,
  TurnMode,
  TurnStatus,
  SessionWire,
  MessageWire,
  TurnWire,
  SessionMessagesResult,
  SessionsListResult,
  SessionsGroupedResult,
  SessionsSearchResult,
  SessionSearchItem,
  ForkResult,
} from '@ema-agent/contracts';

// ── Branch wire types (session-layer only, not in contracts) ─────────────────

export interface BranchNodeWire {
  branchId:       BranchId;
  parentBranchId: BranchId | null;
  forkFromTurnId: TurnId   | null;
  /** First ≤30 chars of the user query at the fork point. */
  forkUserInput:  string;
  forkTurnMode:   TurnMode | null;
  isActive:       boolean;
  createdAt:      number;
}

export interface TurnTreeNodeWire {
  id:        TurnId;
  branchId:  BranchId | null;
  startedAt: number;
  mode:      TurnMode;
  userInput: string;
  status:    TurnStatus;
}

export interface BranchTreeWire {
  sessionActiveBranchId: BranchId | null;
  branches:              BranchNodeWire[];
  turns:                 TurnTreeNodeWire[];
}

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
      lastMode?: TurnMode | null;
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

  /** POST /api/sessions/:id/fork — fork a session. */
  async fork(id: SessionId): Promise<ForkResult> {
    return sidecarClient.request<ForkResult>(`/api/sessions/${id}/fork`, { method: 'POST' });
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

  // ── Branch operations ────────────────────────────────────────────────────

  /** GET /api/sessions/:id/branches — all branches with fork-point metadata. */
  async listBranches(id: SessionId): Promise<BranchTreeWire> {
    return sidecarClient.request<BranchTreeWire>(`/api/sessions/${id}/branches`);
  },

  /**
   * POST /api/sessions/:id/branches — fork the session at a specific turn.
   * Creates a new empty branch starting after `fromTurnId` and sets it active.
   */
  async forkBranch(id: SessionId, fromTurnId: TurnId): Promise<{ branchId: BranchId }> {
    return sidecarClient.request<{ branchId: BranchId }>(`/api/sessions/${id}/branches`, {
      method: 'POST',
      json: { fromTurnId },
    });
  },

  /**
   * PUT /api/sessions/:id/branches/active — switch to a different branch.
   * Pass null to reset to the root (only valid before any fork).
   */
  async switchBranch(id: SessionId, branchId: BranchId | null): Promise<void> {
    await sidecarClient.request(`/api/sessions/${id}/branches/active`, {
      method: 'PUT',
      json: { branchId },
    });
  },

  /** DELETE /api/sessions/:id/turns/:turnId — 删除该 turn 及其全部下游(级联)。 */
  async deleteTurn(id: SessionId, turnId: TurnId): Promise<DeleteTurnCascadeResult> {
    return sidecarClient.request<DeleteTurnCascadeResult>(
      `/api/sessions/${id}/turns/${turnId}`,
      { method: 'DELETE' },
    );
  },
};

/** DELETE /api/sessions/:id/turns/:turnId 的级联删除清单。 */
export interface DeleteTurnCascadeResult {
  /** 被删除的 turn(目标及全部下游)。 */
  deletedTurnIds:   string[];
  /** 被整支删除的分支(按深度从深到浅)。 */
  deletedBranchIds: string[];
}

