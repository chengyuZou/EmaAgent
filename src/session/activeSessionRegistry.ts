// 同一个 Session 只允许一个根 Turn 或一次手动 Compact 运行. 这里保存它的
// 真实身份和取消信号, 让取消、终态清理与 WebSocket 初始状态指向同一份工作.

import { ActiveSessionAlreadyRegisteredError, SessionBusyError } from './errors.js';

export type ActiveSession =
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'compact'; readonly compactId: string };

interface ActiveSessionEntry {
  readonly active: ActiveSession;
  readonly controller: AbortController;
}

export class ActiveSessionRegistry {
  private readonly activeBySession = new Map<string, ActiveSessionEntry>();
  /**
   * Session 删除和 Server 关闭发出取消信号后, 会把等待该 Session 收尾的
   * Promise resolve 回调放在这里. clear() 或 discardSession() 清除运行记录时统一唤醒.
   */
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private readonly listeners = new Set<(
    sessionId: string,
    active: ActiveSession | null,
  ) => void>();
  private registrationClosures = 0;
  private registrationClosureTail: Promise<void> = Promise.resolve();

  register(sessionId: string, active: ActiveSession): AbortSignal {
    if (this.registrationClosures > 0) {
      throw new SessionBusyError(sessionId);
    }
    if (this.activeBySession.has(sessionId)) {
      throw new ActiveSessionAlreadyRegisteredError(sessionId);
    }

    const controller = new AbortController();
    this.activeBySession.set(sessionId, { active, controller });
    this.notifyListeners(sessionId, active);
    return controller.signal;
  }

  /** 只取消身份匹配的工作. 迟到的取消请求不能停止同 Session 后来开始的新工作. */
  abort(sessionId: string, requested: ActiveSession): boolean {
    const entry = this.activeBySession.get(sessionId);
    if (!entry || !sameActiveSession(entry.active, requested)) return false;
    entry.controller.abort();
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.activeBySession.has(sessionId);
  }

  getActiveSession(sessionId: string): ActiveSession | undefined {
    return this.activeBySession.get(sessionId)?.active;
  }

  /** 只清除身份匹配的工作. 迟到的 finally 不能清掉同 Session 后来开始的新工作. */
  clear(sessionId: string, completed: ActiveSession): boolean {
    const entry = this.activeBySession.get(sessionId);
    if (!entry || !sameActiveSession(entry.active, completed)) return false;
    this.activeBySession.delete(sessionId);
    this.notifyListeners(sessionId, null);
    this.notifyIdle(sessionId);
    return true;
  }

  /** Session 永久删除时丢弃运行态, 普通执行终态不得使用该入口. */
  discardSession(sessionId: string): boolean {
    if (!this.activeBySession.delete(sessionId)) return false;
    this.notifyListeners(sessionId, null);
    this.notifyIdle(sessionId);
    return true;
  }

  /**
   * 等待该 Session 当前的根 Turn 或手动 Compact 通过 clear() 或 discardSession() 自己完成收尾并清除运行记录.
   * Session 删除会先发出取消信号, 再在这里等它们停止落库并通过 clear() 或 discardSession() 清理 waitUntilIdle 存入的 Promise resolve 回调.
   * Server 关闭也用同一等待方式, 避免在工作仍可能写入 Turn 终态或 Compact 摘要时删除 Session 数据或关闭数据库.
   */
  waitUntilIdle(sessionId: string): Promise<void> {
    if (!this.activeBySession.has(sessionId)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.idleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(sessionId, waiters);
    });
  }

  activeSessionCount(): number {
    return this.activeBySession.size;
  }

/** 切换全局角色前停止全部根 Turn 与手动 Compact, 并等待各执行所有者完成收尾. */
  async abortAll(): Promise<void> {
    const active = [...this.activeBySession.entries()];
    for (const [, entry] of active) entry.controller.abort();
    await Promise.all(active.map(([sessionId]) => this.waitUntilIdle(sessionId)));
  }

  /**
   * 角色切换 删除和当前角色修改在这个窗口内完成检查与提交 调用本方法会同步
   * 关闭新 Turn/Compact 注册；并发调用按进入顺序串行，最后一个调用结束后再开放。
   */
  runWithRegistrationsClosed<T>(action: () => T | Promise<T>): Promise<T> {
    this.registrationClosures += 1;
    const result = this.registrationClosureTail.then(action);
    this.registrationClosureTail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.registrationClosures -= 1;
    });
  }

  /** Server 用这个变化通知刷新已连接的 Chat. 新连接仍通过 getActiveSession 读取当前值. */
  subscribe(listener: (sessionId: string, active: ActiveSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(sessionId: string, active: ActiveSession | null): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId, active);
      } catch {
        // UI 通知失败不能回滚已经生效的 Session 工作状态.
      }
    }
  }

  private notifyIdle(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId);
    if (!waiters) return;
    this.idleWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  }
}

function sameActiveSession(left: ActiveSession, right: ActiveSession): boolean {
  if (left.kind === 'turn') {
    return right.kind === 'turn' && left.turnId === right.turnId;
  }
  return right.kind === 'compact' && left.compactId === right.compactId;
}
