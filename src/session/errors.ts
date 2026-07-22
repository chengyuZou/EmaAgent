import type { SessionId } from '@ema-agent/contracts';
import type { SessionOwnedEntity } from './types.js';

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
