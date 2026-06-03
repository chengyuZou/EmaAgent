import crypto from 'node:crypto';

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
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 120_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Create a pending prompt with an auto-generated promptId. */
  create(timeoutMs?: number): {
    promptId: string;
    promise: Promise<Record<string, string>>;
  } {
    const promptId = crypto.randomUUID();
    const promise = this._makePromise(promptId, timeoutMs);
    return { promptId, promise };
  }

  /**
   * Create a pending prompt keyed to a caller-supplied promptId.
   *
   * Use this when the tool has already generated the promptId and broadcast
   * it in an SSE event (ask_user_required). The frontend will POST that same
   * promptId back, so the registry entry must be keyed to it.
   */
  createWithId(promptId: string, timeoutMs?: number): {
    promise: Promise<Record<string, string>>;
  } {
    return { promise: this._makePromise(promptId, timeoutMs) };
  }

  private _makePromise(promptId: string, timeoutMs?: number): Promise<Record<string, string>> {
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<Record<string, string>>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(promptId)) {
          resolve({}); // empty answers on timeout
        }
      }, ms);
      this.pending.set(promptId, { resolve, timer });
    });
  }

  /**
   * Resolve a pending prompt with user-provided answers.
   * Returns false if the promptId was not found (already resolved / expired).
   */
  respond(promptId: string, answers: Record<string, string>): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(promptId);
    entry.resolve(answers);
    return true;
  }

  /** Cancel a pending prompt (e.g. turn aborted). Resolves with empty answers. */
  cancel(promptId: string): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(promptId);
    entry.resolve({});
    return true;
  }

  /** Cancel all prompts for a given turn id (not yet needed — V1.5). */
  size(): number {
    return this.pending.size;
  }
}
