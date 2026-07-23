import crypto from 'node:crypto';
import type { AskUserRequiredEvent, PendingAskUserPrompt } from '@ema-agent/tools';

/**
 * In-memory registry for ask_user tool prompts awaiting user answers.
 *
 * Mirrors PermissionPromptRegistry: a tool calls create() to get a
 * { promptId, promise }, emits the promptId over SSE to the frontend,
 * and awaits the promise. The frontend posts user answers to the
 * respond() endpoint which resolves the promise.
 */
export class AskUserRegistry {
  private readonly pending = new Map<
    string,
    {
      resolve: (answers: Record<string, string>) => void;
      timer:   ReturnType<typeof setTimeout>;
      turnId?: string;
      createdAt: number;
      request?: AskUserRequiredEvent;
    }
  >();

  // turnId → set of promptIds waiting on that turn
  private readonly byTurn = new Map<string, Set<string>>();

  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 120_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Create a pending prompt with an auto-generated promptId. */
  create(timeoutMs?: number, turnId?: string): {
    promptId: string;
    promise:  Promise<Record<string, string>>;
  } {
    const promptId = crypto.randomUUID();
    const promise  = this._makePromise(promptId, timeoutMs, turnId);
    return { promptId, promise };
  }

  /**
   * Create a pending prompt keyed to a caller-supplied promptId.
   *
   * Use this when the tool has already generated the promptId and broadcast
   * it in an SSE event (ask_user_required). The frontend will POST that same
   * promptId back, so the registry entry must be keyed to it.
   *
   * Pass `turnId` so the prompt can be batch-cancelled when its turn ends.
   */
  createWithId(
    promptId: string,
    timeoutMs?: number,
    turnId?: string,
    request?: AskUserRequiredEvent,
  ): {
    promise: Promise<Record<string, string>>;
  } {
    return { promise: this._makePromise(promptId, timeoutMs, turnId, request) };
  }

  private _makePromise(
    promptId:  string,
    timeoutMs?: number,
    turnId?:   string,
    request?:  AskUserRequiredEvent,
  ): Promise<Record<string, string>> {
    const ms = timeoutMs ?? this.defaultTimeoutMs;

    if (turnId) {
      let set = this.byTurn.get(turnId);
      if (!set) { set = new Set(); this.byTurn.set(turnId, set); }
      set.add(promptId);
    }

    return new Promise<Record<string, string>>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(promptId)) {
          if (turnId) this.byTurn.get(turnId)?.delete(promptId);
          resolve({});
        }
      }, ms);
      this.pending.set(promptId, { resolve, timer, turnId, createdAt: Date.now(), request });
    });
  }

  /**
   * Resolve a pending prompt with user-provided answers.
   * Returns false if the promptId was not found (already resolved / expired).
   */
  respond(promptId: string, answers: Record<string, string>, expectedTurnId?: string): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    if (expectedTurnId && entry.turnId !== expectedTurnId) return false;
    clearTimeout(entry.timer);
    this.pending.delete(promptId);
    if (entry.turnId) this.byTurn.get(entry.turnId)?.delete(promptId);
    entry.resolve(answers);
    return true;
  }

  /** Cancel a single pending prompt (resolves with empty answers). */
  cancel(promptId: string, expectedTurnId?: string): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    if (expectedTurnId && entry.turnId !== expectedTurnId) return false;
    clearTimeout(entry.timer);
    this.pending.delete(promptId);
    if (entry.turnId) this.byTurn.get(entry.turnId)?.delete(promptId);
    entry.resolve({});
    return true;
  }

  /**
   * Cancel all pending ask_user prompts for a given turn.
   * Called when a turn reaches any terminal state so prompts don't hang
   * until the 120 s timeout fires.
   * Returns the number of prompts cancelled.
   */
  cancelForTurn(turnId: string): number {
    const promptIds = this.byTurn.get(turnId);
    if (!promptIds || promptIds.size === 0) {
      this.byTurn.delete(turnId);
      return 0;
    }
    let n = 0;
    for (const promptId of [...promptIds]) {
      if (this.cancel(promptId)) n++;
    }
    this.byTurn.delete(turnId);
    return n;
  }

  size(): number {
    return this.pending.size;
  }

  /** 返回窗口可以重建的请求；旧式无结构化载荷的调用不会伪造恢复数据。 */
  listPending(): PendingAskUserPrompt[] {
    return [...this.pending.values()]
      .filter((entry): entry is typeof entry & { request: AskUserRequiredEvent } => entry.request !== undefined)
      .map((entry) => ({ createdAt: entry.createdAt, request: entry.request }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }
}
