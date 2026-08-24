/** 业务层发现跨 Session 引用时抛出的稳定错误。 */
export class SessionOwnershipError extends Error {
  readonly code = 'session_ownership_violation' as const;

  constructor(message: string) {
    super(`session_ownership_violation: ${message}`);
    this.name = 'SessionOwnershipError';
  }
}

/** 同一 Session 已有活跃执行（根 Turn 或手动 compact）时拒绝新执行；路由层映射为 409。 */
export class SessionBusyError extends Error {
  readonly code = 'session_busy' as const;

  constructor(sessionId: string) {
    super(`session_busy: an execution is already running for session ${sessionId}`);
    this.name = 'SessionBusyError';
  }
}

/** 同一 Session 已有活跃执行时又注册一个，抛出的进程内不变量错误。 */
export class ActiveSessionAlreadyRegisteredError extends Error {
  readonly code = 'active_session_already_registered' as const;

  constructor(sessionId: string) {
    super(`active_session_already_registered: ${sessionId}`);
    this.name = 'ActiveSessionAlreadyRegisteredError';
  }
}
