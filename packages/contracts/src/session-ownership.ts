import type { BranchId, MessageId, SessionId, TurnId } from './ids.js';

/**
 * Session 聚合的归属校验端口。
 *
 * 其他模块只能依赖这个窄 Facade，不能直接读取 session 内部仓储。
 */
export interface SessionOwnershipFacade {
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void;
  assertMessageOwnership(sessionId: SessionId, messageId: MessageId): void;
  assertBranchOwnership(sessionId: SessionId, branchId: BranchId): void;
}

export type SessionOwnedEntity = 'artifact' | 'branch' | 'message' | 'turn';

/** 业务层发现跨 Session 引用时抛出的稳定错误。 */
export class SessionOwnershipError extends Error {
  readonly code = 'session_ownership_violation' as const;

  constructor(
    readonly entity: SessionOwnedEntity,
    readonly entityId: string,
    readonly expectedSessionId: SessionId,
    readonly actualSessionId: SessionId,
  ) {
    super(
      `session_ownership_violation: ${entity} ${entityId} belongs to session `
      + `${actualSessionId}, not ${expectedSessionId}`,
    );
    this.name = 'SessionOwnershipError';
  }
}
