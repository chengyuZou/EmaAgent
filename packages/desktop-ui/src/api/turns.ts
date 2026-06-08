/**
 * Turns API — POST /api/turns, SSE events URL, merged audio URL.
 */
import { sidecarClient } from './sidecar-client.js';
import type { TurnId, SessionId, TurnMode, AgentSubMode, MessageContentPart } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateTurnRequest {
  sessionId?:    string;
  mode:          TurnMode;
  agentSubMode?: AgentSubMode;
  userInput?:    string;
  contentParts?: MessageContentPart[];
  model?:        string;
  ttsEnabled?:   boolean;
}

export interface CreateTurnResponse {
  turnId:    TurnId;
  sessionId: SessionId;
}

// ── API object ────────────────────────────────────────────────────────────────

export const turnsApi = {
  /** POST /api/turns — start a new turn. */
  async create(req: CreateTurnRequest): Promise<CreateTurnResponse> {
    // Local validation
    if (!req.mode) throw new Error('mode is required');
    const hasInput = req.userInput || (req.contentParts && req.contentParts.length > 0);
    if (!hasInput) throw new Error('either userInput or contentParts is required');

    return sidecarClient.request<CreateTurnResponse>('/api/turns', {
      method: 'POST',
      json: req,
    });
  },

  /** Build the SSE URL for a turn's event stream. */
  async eventsUrl(turnId: TurnId, opts?: { lastEventId?: number }): Promise<string> {
    return sidecarClient.streamUrl(`/api/turns/${turnId}/events`, {
      lastEventId: opts?.lastEventId,
    });
  },

  /** Build the merged audio URL for a completed turn. */
  async audioUrl(turnId: TurnId): Promise<string> {
    return sidecarClient.streamUrl(`/api/turns/${turnId}/audio`);
  },

  /** POST /api/turns/:turnId/ask-user/:promptId/respond */
  respondAskUser(
    turnId:   string,
    promptId: string,
    answers:  Record<string, string>,
  ): Promise<{ ok: boolean }> {
    return sidecarClient.request(
      `/api/turns/${turnId}/ask-user/${promptId}/respond`,
      { method: 'POST', json: { answers } },
    );
  },
};
