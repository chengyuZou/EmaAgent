/**
 * Turns API — POST /api/turns, SSE events URL, merged audio URL.
 */
import { sidecarClient } from './sidecar-client.js';
import { hasTurnRequestInput } from '@ema-agent/turn';
import type {
  TurnId,
} from '@ema-agent/contracts';
import type {
  PendingAskUserPrompt,
  TurnCreatedResponse,
  TurnRequest,
} from '@ema-agent/turn';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Mirrors the backend's attachmentInputSchema；fileHandle 是桌面宿主签发的加密能力。
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
  fileHandle: string;
}

// Re-export the canonical wire types so existing import sites keep working.
export type { TurnRequest, TurnCreatedResponse } from '@ema-agent/turn';

// ── API object ────────────────────────────────────────────────────────────────

export const turnsApi = {
  /** GET /api/turns/pending/ask-user — recover prompts after reopening the chat window. */
  pendingAskUser(): Promise<{ count: number; prompts: PendingAskUserPrompt[] }> {
    return sidecarClient.request('/api/turns/pending/ask-user');
  },

  /** POST /api/turns — start a new turn. */
  async create(req: TurnRequest): Promise<TurnCreatedResponse> {
    // Local validation
    if (req.trigger.type !== 'userMessage') throw new Error('unsupported turn trigger');
    if (!req.executionProfile) throw new Error('executionProfile is required');
    if (!req.narrativePolicy) throw new Error('narrativePolicy is required');
    if (!hasTurnRequestInput(req)) {
      throw new Error('either userInput, contentParts, or attachments is required');
    }
    return sidecarClient.request<TurnCreatedResponse>('/api/turns', {
      method: 'POST',
      json: req,
    });
  },

  /** 打开 Turn 事件流，复用 Sidecar 的动态端口、认证与错误处理。 */
  openEvents(turnId: TurnId, lastEventId: number, signal: AbortSignal): Promise<Response> {
    const params = new URLSearchParams();
    if (lastEventId > 0) params.set('lastEventId', String(lastEventId));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return sidecarClient.requestRaw(`/api/turns/${turnId}/events${query}`, {
      signal,
      headers: { Accept: 'text/event-stream' },
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

  /** POST /api/turns/:turnId/ask-user/:promptId/cancel */
  cancelAskUser(turnId: string, promptId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(
      `/api/turns/${turnId}/ask-user/${promptId}/cancel`,
      { method: 'POST' },
    );
  },
};
