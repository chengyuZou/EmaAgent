/** 业务层发现跨 Session 引用时抛出的稳定错误. */
export class SessionOwnershipError extends Error {
  readonly code = 'session_ownership_violation' as const;

  constructor(message: string) {
    super(`session_ownership_violation: ${message}`);
    this.name = 'SessionOwnershipError';
  }
}

/** 同一 Session 已有根 Turn 或手动 Compact 时拒绝启动另一份根工作. */
export class SessionBusyError extends Error {
  readonly code = 'session_busy' as const;

  constructor(sessionId: string) {
    super(`session_busy: session ${sessionId} already has running work`);
    this.name = 'SessionBusyError';
  }
}

/** 同一 Session 已有根 Turn 或手动 Compact 时又注册一份工作, 表示调用链重复注册. */
export class SessionRunningAlreadyRegisteredError extends Error {
  readonly code = 'session_running_already_registered' as const;

  constructor(sessionId: string) {
    super(`session_running_already_registered: ${sessionId}`);
    this.name = 'SessionRunningAlreadyRegisteredError';
  }
}
