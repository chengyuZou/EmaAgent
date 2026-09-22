// 同一个 Session 只允许一个根 Turn 或一次手动 Compact 运行. 这里保存它的
// 真实身份和取消信号, 让取消、终态清理与 WebSocket 连接当前值指向同一份工作.

import { SessionBusyError, SessionRunningAlreadyRegisteredError } from './errors.js';

export type SessionRunning =
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'compact'; readonly compactId: string };

interface SessionRunningEntry {
  readonly running: SessionRunning;
  readonly controller: AbortController;
}

/** 保存各 Session 当前根工作的真实身份和 AbortController. */
export class SessionRunningRegistry {
  private readonly runningBySession = new Map<string, SessionRunningEntry>();
  /**
   * Session 删除和 Server 关闭发出取消信号后, 会把等待该 Session 收尾的
   * Promise resolve 回调放在这里. clear() 或 discardSession() 清除运行记录时统一唤醒.
   */
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private readonly listeners = new Set<(
    sessionId: string,
    running: SessionRunning | null,
  ) => void>();
  private registrationClosures = 0;
  private registrationClosureTail: Promise<void> = Promise.resolve();

  register(sessionId: string, running: SessionRunning): AbortSignal {
    if (this.registrationClosures > 0) {
      throw new SessionBusyError(sessionId);
    }
    if (this.runningBySession.has(sessionId)) {
      throw new SessionRunningAlreadyRegisteredError(sessionId);
    }

    const controller = new AbortController();
    this.runningBySession.set(sessionId, { running, controller });
    this.notifyListeners(sessionId, running);
    return controller.signal;
  }

  /** 只取消身份匹配的工作. 迟到的取消请求不能停止同 Session 后来开始的新工作. */
  abort(sessionId: string, requested: SessionRunning): boolean {
    const entry = this.runningBySession.get(sessionId);
    if (!entry || !sameSessionRunning(entry.running, requested)) return false;
    entry.controller.abort();
    return true;
  }

  /** 是否已经有根 Turn 或手动 Compact 占用这个 Session. */
  isRunning(sessionId: string): boolean {
    return this.runningBySession.has(sessionId);
  }

  /** 返回指定 Session 当前运行的根 Turn 或手动 Compact, 不是 Session 实体. */
  getRunning(sessionId: string): SessionRunning | undefined {
    return this.runningBySession.get(sessionId)?.running;
  }

  /** 只清除身份匹配的工作. 迟到的 finally 不能清掉同 Session 后来开始的新工作. */
  clear(sessionId: string, completed: SessionRunning): boolean {
    const entry = this.runningBySession.get(sessionId);
    if (!entry || !sameSessionRunning(entry.running, completed)) return false;
    this.runningBySession.delete(sessionId);
    this.notifyListeners(sessionId, null);
    this.notifyIdle(sessionId);
    return true;
  }

  /** Session 永久删除时丢弃运行记录, 普通执行终态不得使用该入口. */
  discardSession(sessionId: string): boolean {
    if (!this.runningBySession.delete(sessionId)) return false;
    this.notifyListeners(sessionId, null);
    this.notifyIdle(sessionId);
    return true;
  }

  /**
   * 等待该 Session 当前的根 Turn 或手动 Compact 通过 clear() 完成自己的收尾.
   * Session 删除和 Server 关闭都必须等写入停止后, 才能删除 Session 数据或关闭数据库.
   */
  waitUntilIdle(sessionId: string): Promise<void> {
    if (!this.runningBySession.has(sessionId)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.idleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(sessionId, waiters);
    });
  }

  /** 返回当前有根工作运行的 Session 数量, 角色切换和视觉服务空闲判断会读取它. */
  runningSessionCount(): number {
    return this.runningBySession.size;
  }

  /** 切换全局角色前停止全部根 Turn 与手动 Compact, 并等待各执行所有者完成收尾. */
  async abortAll(): Promise<void> {
    const running = [...this.runningBySession.entries()];
    for (const [, entry] of running) entry.controller.abort();
    await Promise.all(running.map(([sessionId]) => this.waitUntilIdle(sessionId)));
  }

  /**
   * 角色切换、删除和当前角色修改在这个窗口内完成检查与提交. 调用本方法会同步
   * 关闭新 Turn/Compact 注册; 并发调用按进入顺序串行, 最后一个调用结束后再开放.
   */
  runWithRegistrationsClosed<T>(action: () => T | Promise<T>): Promise<T> {
    this.registrationClosures += 1;
    const result = this.registrationClosureTail.then(action);
    this.registrationClosureTail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.registrationClosures -= 1;
    });
  }

  /** Server 用这个变化通知已连接的 Chat. 新连接通过 getRunning() 读取当前值. */
  subscribe(listener: (sessionId: string, running: SessionRunning | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(sessionId: string, running: SessionRunning | null): void {
    for (const listener of [...this.listeners]) {
      listener(sessionId, running);
    }
  }

  private notifyIdle(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId);
    if (!waiters) return;
    this.idleWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  }
}

function sameSessionRunning(left: SessionRunning, right: SessionRunning): boolean {
  if (left.kind === 'turn') {
    return right.kind === 'turn' && left.turnId === right.turnId;
  }
  return right.kind === 'compact' && left.compactId === right.compactId;
}
