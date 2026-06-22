/**
 * Turns API — POST /api/turns, SSE events URL, merged audio URL.
 */
import { sidecarClient } from './sidecar-client.js';
import type { TurnId, SessionId, TurnMode, MessageContentPart } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mirrors the backend's attachmentInputSchema — localPath is the absolute FS path. */
export interface AttachmentInputWire {
  id:        string;
  name:      string;
  mimeType:  string;
  size:      number;
  mtime:     number;
  localPath: string;
}

export interface CreateTurnRequest {
  sessionId?:    string;
  mode:          TurnMode;
  userInput?:    string;
  contentParts?: MessageContentPart[];
  /** Per-turn file attachments. Images → base64 contentParts; others → path block appended to prompt. */
  attachments?:  AttachmentInputWire[];
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

  /** DELETE /api/turns/:turnId/subagents/:subagentId — cancel a running subagent. */
  abortSubagent(turnId: string, subagentId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(
      `/api/turns/${turnId}/subagents/${subagentId}`,
      { method: 'DELETE' },
    );
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
