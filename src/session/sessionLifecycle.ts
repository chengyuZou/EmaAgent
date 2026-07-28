// 协调 Session 偏好变更与永久删除时必须同步收口的进程内状态。
import type { SessionId } from '@ema-agent/ids';
import type { Session, PatchSessionInput } from './types.js';

interface SessionLifecycleStore {
  patchSession(sessionId: SessionId, patch: PatchSessionInput): void;
  getSession(sessionId: SessionId): Session;
  deleteSession(sessionId: SessionId): void;
}

interface SessionRuntimeState {
  invalidateSessionRuntime(sessionId: SessionId): void;
  removeSessionRuntime(sessionId: SessionId): void;
}

interface SessionInteractionState {
  cancelForSession(sessionId: SessionId, reason: string): void;
}

interface SessionPermissionState {
  clearSession(sessionId: SessionId): void;
}

export interface SessionLifecycleDeps {
  session: SessionLifecycleStore;
  runtime: SessionRuntimeState;
  interactions: SessionInteractionState;
  permissions: SessionPermissionState;
}

/**
 * Session 的数据库行不是完整生命周期：工作区变更会使 Runner 失效，
 * 永久删除也必须同步取消等待中的用户决策并释放进程内缓存。
 */
export class SessionLifecycle {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  updateSession(sessionId: SessionId, patch: PatchSessionInput): Session {
    this.deps.session.patchSession(sessionId, patch);
    if (patch.workspaceRoot !== undefined) {
      this.deps.runtime.invalidateSessionRuntime(sessionId);
    }
    return this.deps.session.getSession(sessionId);
  }

  deleteSession(sessionId: SessionId): void {
    this.deps.interactions.cancelForSession(sessionId, 'session deleted');
    this.deps.permissions.clearSession(sessionId);
    this.deps.runtime.removeSessionRuntime(sessionId);
    this.deps.session.deleteSession(sessionId);
  }
}
