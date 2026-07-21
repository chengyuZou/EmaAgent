import type { SessionId, TurnId } from '@ema-agent/contracts';

interface ActiveRun {
  turnId: TurnId;
  abortController: AbortController;
}

/**
 * In-memory registry of currently running turns.
 *
 * Serves two purposes:
 *   1. Fast per-session concurrency check (no DB round-trip needed).
 *   2. Holds the AbortController so a running LLM stream can be cancelled
 *      when the user clicks Stop or the turn fails.
 *
 * State is intentionally not persisted — on process restart, startTurn()
 * calls turnsRepo.abortStale() to heal any DB rows left in 'running' state.
 */
export class RunRegistry {
  private readonly runs = new Map<string, ActiveRun>();

  /**
   * Register a new active turn and return its AbortSignal.
   * Pass the signal to llm.stream() so cancellation propagates automatically.
   */
  register(sessionId: SessionId, turnId: TurnId): AbortSignal {
    const abortController = new AbortController();
    this.runs.set(sessionId as string, { turnId, abortController });
    return abortController.signal;
  }

  /**
   * Fire the AbortController for the session's running turn.
   * Returns false if no turn is registered (idempotent).
   */
  abort(sessionId: SessionId): boolean {
    const run = this.runs.get(sessionId as string);
    if (!run) return false;
    run.abortController.abort();
    return true;
  }

  isRunning(sessionId: SessionId): boolean {
    return this.runs.has(sessionId as string);
  }

  getActiveTurnId(sessionId: SessionId): TurnId | undefined {
    return this.runs.get(sessionId as string)?.turnId;
  }

  /** Call after turn reaches any terminal state (completed/failed/aborted). */
  clear(sessionId: SessionId): void {
    this.runs.delete(sessionId as string);
  }

  /** For observability / debugging. */
  activeSessionCount(): number {
    return this.runs.size;
  }
}