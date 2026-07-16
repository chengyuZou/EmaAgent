import crypto from 'node:crypto';
import type { PermissionResponse } from '@ema-agent/permission';

// ── Permission prompt registry ───────────────────────────────────────────────

interface PendingPrompt {
  resolve:   (response: PermissionResponse) => void;
  timer:     ReturnType<typeof setTimeout>;
  sessionId: string;
  turnId:    string;
  toolCallId: string;
  createdAt: number;
}

/**
 * In-memory registry of permission prompts awaiting a user response.
 *
 *   1. AgentEngine's per-turn askCallback calls `create(...)` → emits
 *      a `permission_required` SSE event with `promptId`.
 *   2. Frontend shows persistent UI, POSTs to /api/permission/:promptId/respond.
 *   3. Route handler calls `respond(promptId, response)` → resolves the promise
 *      → askCallback returns → PermissionEngine.gate continues.
 *
 * Timeout default-deny: prompts auto-resolve with `{ action: 'deny', reason:
 * 'timeout' }` if the user doesn't respond within the configured window.
 *
 * Process-local. No persistence — turn abort or process restart cancels every
 * pending prompt (the agent loop catches the denial and surfaces it as a tool
 * error, which is the right behaviour for a daemon).
 */
export class PermissionPromptRegistry {
  private readonly prompts = new Map<string, PendingPrompt>();
  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 120_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Live-update the default timeout (used by /api/settings/permission-timeout). */
  setDefaultTimeout(ms: number): void {
    this.defaultTimeoutMs = ms;
  }

  /**
   * Reserve a new prompt slot. Returns the generated `promptId` and a Promise
   * that resolves when the user responds (or when the timeout elapses).
   */
  create(args: {
    sessionId: string;
    turnId:    string;
    toolCallId: string;
    timeoutMs?: number;
  }): { promptId: string; promise: Promise<PermissionResponse> } {
    const promptId = crypto.randomUUID();
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;

    const promise = new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (this.prompts.delete(promptId)) {
          resolve({ action: 'deny', reason: `timed out after ${timeoutMs}ms` });
        }
      }, timeoutMs);

      this.prompts.set(promptId, {
        resolve,
        timer,
        sessionId: args.sessionId,
        turnId:    args.turnId,
        toolCallId: args.toolCallId,
        createdAt: Date.now(),
      });
    });

    return { promptId, promise };
  }

  /**
   * Resolve a pending prompt with the user's response. Returns false when the
   * promptId is unknown or already resolved (timeout / cancellation).
   */
  respond(promptId: string, response: PermissionResponse): boolean {
    const entry = this.prompts.get(promptId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.prompts.delete(promptId);
    entry.resolve(response);
    return true;
  }

  /**
   * Cancel a prompt without a real response — used when the turn aborts.
   * Resolves as deny so the engine cleanly exits the gate.
   */
  cancel(promptId: string, reason = 'cancelled'): boolean {
    const entry = this.prompts.get(promptId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.prompts.delete(promptId);
    entry.resolve({ action: 'deny', reason });
    return true;
  }

  /** Cancel every pending prompt for a specific turn (used on turn abort). */
  cancelForTurn(turnId: string, reason = 'turn aborted'): number {
    let n = 0;
    for (const [promptId, entry] of this.prompts.entries()) {
      if (entry.turnId !== turnId) continue;
      clearTimeout(entry.timer);
      this.prompts.delete(promptId);
      entry.resolve({ action: 'deny', reason });
      n++;
    }
    return n;
  }

  /** Session 删除时取消其全部待审批请求，避免留下悬挂 Promise。 */
  cancelForSession(sessionId: string, reason = 'session deleted'): number {
    let n = 0;
    for (const [promptId, entry] of this.prompts.entries()) {
      if (entry.sessionId !== sessionId) continue;
      clearTimeout(entry.timer);
      this.prompts.delete(promptId);
      entry.resolve({ action: 'deny', reason });
      n++;
    }
    return n;
  }

  /** Diagnostics — count of in-flight prompts. */
  size(): number {
    return this.prompts.size;
  }
}
