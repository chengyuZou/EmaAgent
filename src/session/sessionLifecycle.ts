// 协调 Session 偏好变更与永久删除时必须同步收口的进程内状态。
import type { SessionId } from '@ema-agent/ids';
import type { Session, PatchSessionInput } from './types.js';

interface SessionLifecycleStore {
  patchSession(sessionId: SessionId, patch: PatchSessionInput): void;
  getSession(sessionId: SessionId): Session;
  sessionExists(sessionId: SessionId): boolean;
  beginSessionDeletion(sessionId: SessionId): void;
  cancelSessionDeletion(sessionId: SessionId): void;
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

interface SessionMemoryLifecycle {
  beforeSessionDelete(sessionId: SessionId): Promise<void>;
  afterSessionDelete(sessionId: SessionId): Promise<void>;
  cancelSessionDelete(sessionId: SessionId): void;
}

export interface SessionLifecycleDeps {
  session: SessionLifecycleStore;
  runtime: SessionRuntimeState;
  interactions: SessionInteractionState;
  permissions: SessionPermissionState;
  memory: SessionMemoryLifecycle;
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

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.deps.session.beginSessionDeletion(sessionId);
    try {
      this.deps.interactions.cancelForSession(sessionId, 'session deleted');
      this.deps.permissions.clearSession(sessionId);
      this.deps.runtime.removeSessionRuntime(sessionId);
      await this.deps.memory.beforeSessionDelete(sessionId);
      try {
        this.deps.session.deleteSession(sessionId);
      } finally {
        // 数据行可能已删除，但派生目录清理随后抛错；此时仍须释放
        // Memory 阻塞并清掉 Profile DB 软引用。
        if (!this.deps.session.sessionExists(sessionId)) {
          await this.deps.memory.afterSessionDelete(sessionId);
        }
      }
    } catch (error) {
      if (this.deps.session.sessionExists(sessionId)) {
        this.deps.memory.cancelSessionDelete(sessionId);
        this.deps.session.cancelSessionDeletion(sessionId);
      }
      throw error;
    }
  }
}
