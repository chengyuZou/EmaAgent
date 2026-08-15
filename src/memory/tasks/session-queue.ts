/**
 * Serialises async work within a single session. Different sessions run their
 * tasks in parallel — only same-session work is forced into a chain.
 *
 * Used by the memory pipeline to make sure two `onTurnEnd` extractions for
 * the same session never race on session_notes / pending_fragments.
 *
 * The chain promise is always settled (allSettled-style) so a failure in one
 * task never blocks the next — failure handling lives inside each task.
 */
export class SessionTaskQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const stored = next.catch(() => undefined);
    this.chains.set(sessionId, stored);
    // Auto-evict when this entry is still the tail — prevents the Map from growing
    // unboundedly in long-running processes where users open many sessions.
    void stored.finally(() => {
      if (this.chains.get(sessionId) === stored) this.chains.delete(sessionId);
    });
    return next;
  }

  /** Wait for all currently-queued work for a session to finish. */
  async drain(sessionId: string): Promise<void> {
    const chain = this.chains.get(sessionId);
    if (chain) {
      try { await chain; } catch { /* swallowed by allSettled-style chain */ }
    }
  }

  /** Wait for ALL sessions to drain. Used at graceful shutdown. */
  async drainAll(): Promise<void> {
    const chains = [...this.chains.values()];
    await Promise.allSettled(chains);
  }
}
