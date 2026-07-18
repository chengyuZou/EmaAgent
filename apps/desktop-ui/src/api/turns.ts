/**
 * Turns API — POST /api/turns, SSE events URL, merged audio URL.
 */
import { sidecarClient } from './sidecar-client.js';
import { hasTurnRequestInput } from '@ema-agent/contracts';
import type { TurnId, TurnRequest, TurnCreatedResponse } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Mirrors the backend's attachmentInputSchema — localPath is the absolute FS path.
 * Stricter than contracts `TurnAttachment` (size/mtime required here) so the UI
 * can rely on them; still assignable to TurnAttachment[], which is what
 * TurnRequest.attachments expects.
 */
export interface AttachmentInputWire {
  id:        string;
  name:      string;
  mimeType:  string;
  size:      number;
  mtime:     number;
  localPath: string;
}

// Re-export the canonical wire types so existing import sites keep working.
export type { TurnRequest, TurnCreatedResponse } from '@ema-agent/contracts';

// ── API object ────────────────────────────────────────────────────────────────

export const turnsApi = {
  /** POST /api/turns — start a new turn. */
  async create(req: TurnRequest): Promise<TurnCreatedResponse> {
    // Local validation
    if (!req.mode) throw new Error('mode is required');
    if (!hasTurnRequestInput(req)) {
      throw new Error('either userInput, contentParts, or attachments is required');
    }
    return sidecarClient.request<TurnCreatedResponse>('/api/turns', {
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

  /** DELETE /api/turns/:turnId/tools/:callId — cancel a single in-flight tool. */
  abortTool(turnId: string, callId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(
      `/api/turns/${turnId}/tools/${callId}`,
      { method: 'DELETE' },
    );
  },

  /** POST /api/turns/:turnId/abort — cancel the whole turn (LLM stream + all tools). */
  abortTurn(turnId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(
      `/api/turns/${turnId}/abort`,
      { method: 'POST' },
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
