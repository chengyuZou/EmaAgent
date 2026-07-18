export class AgentTurnLifecycleError extends Error {
  readonly code = 'turn/lifecycle_inconsistent';

  constructor(
    readonly action: 'start' | 'complete' | 'fail' | 'abort',
    readonly turnId: string,
    detail: string,
  ) {
    super(`Agent Turn lifecycle ${action} failed for ${turnId}: ${detail}`);
    this.name = 'AgentTurnLifecycleError';
  }
}
