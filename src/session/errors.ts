/** 业务层发现跨 Session 引用时抛出的稳定错误。 */
export class SessionOwnershipError extends Error {
  readonly code = 'session_ownership_violation' as const;

  constructor(message: string) {
    super(`session_ownership_violation: ${message}`);
    this.name = 'SessionOwnershipError';
  }
}
