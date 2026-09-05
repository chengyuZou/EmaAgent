// 同 Session 一个活跃执行：根 Turn（kind='turn'）与手动 compact（kind='compact'）
// 共享同一坑位，占用者以 kind 区分——compact 的 abort 入口只认 kind='compact'，
// 拒绝误取消正在运行的根 Turn。归 session 包：它守的是 Session 级执行互斥，
// 不是 Turn 的内部状态。

import { ActiveSessionAlreadyRegisteredError, SessionBusyError } from './errors.js';

export type ActiveSessionExecutionKind = 'turn' | 'compact';

export interface ActiveSessionExecution {
  readonly executionId: string;
  readonly kind: ActiveSessionExecutionKind;
}

interface ActiveExecution extends ActiveSessionExecution {
  abortController: AbortController;
}

export class ActiveSessionRegistry {
  private readonly executions = new Map<string, ActiveExecution>();
  /** 等待指定 Session 坑位释放的编排方（Session 删除）。 */
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  /**
   * 订阅方是 Server 的后台维护调度：低优先级维护只在无前台执行时运行，
   * 订阅让最后一个执行结束时后台立刻被唤醒，而不是轮询空转。
   */
  private readonly listeners = new Set<(activeCount: number) => void>();
  private registrationClosures = 0;
  private registrationClosureTail: Promise<void> = Promise.resolve();

  register(
    sessionId: string,
    executionId: string,
    kind: ActiveSessionExecutionKind,
  ): AbortSignal {
    if (this.registrationClosures > 0) {
      throw new SessionBusyError(sessionId);
    }
    if (this.executions.has(sessionId)) {
      throw new ActiveSessionAlreadyRegisteredError(sessionId);
    }

    const abortController = new AbortController();
    this.executions.set(sessionId, { executionId, kind, abortController });
    this.notifyListeners();
    return abortController.signal;
  }

  /** 只取消身份匹配的活跃执行；迟到请求不会影响后继执行。 */
  abort(sessionId: string, executionId: string): boolean {
    const active = this.executions.get(sessionId);
    if (!active || active.executionId !== executionId) return false;
    active.abortController.abort();
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.executions.has(sessionId);
  }

  getActiveExecution(sessionId: string): ActiveSessionExecution | undefined {
    const active = this.executions.get(sessionId);
    return active ? { executionId: active.executionId, kind: active.kind } : undefined;
  }

  /** 只清除身份匹配的活跃执行；返回 false 表示条目已更换或不存在。 */
  clear(sessionId: string, executionId: string): boolean {
    const active = this.executions.get(sessionId);
    if (!active || active.executionId !== executionId) return false;
    this.executions.delete(sessionId);
    this.notifyListeners();
    this.notifyIdle(sessionId);
    return true;
  }

  /** Session 永久删除时丢弃运行态；普通执行终态不得使用该入口。 */
  discardSession(sessionId: string): boolean {
    if (!this.executions.delete(sessionId)) return false;
    this.notifyListeners();
    this.notifyIdle(sessionId);
    return true;
  }

  /**
   * 等待指定 Session 的坑位释放；唯一消费者是 Session 删除编排——它向坑内执行
   * （Turn 或手动 compact）发过停止信号后，必须等执行所有者自己收尾退出，
   * 否则删除会与在飞的摘要落库/持久化竞争。
   */
  waitUntilIdle(sessionId: string): Promise<void> {
    if (!this.executions.has(sessionId)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.idleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(sessionId, waiters);
    });
  }

  activeSessionCount(): number {
    return this.executions.size;
  }

  /** 切换全局角色前停止全部根 Turn 与手动 Compact，并等待各执行所有者完成收尾。 */
  async abortAll(): Promise<void> {
    const active = [...this.executions.entries()];
    for (const [, execution] of active) execution.abortController.abort();
    await Promise.all(active.map(([sessionId]) => this.waitUntilIdle(sessionId)));
  }

  /**
   * 角色切换、删除和当前角色修改在这个窗口内完成检查与提交。调用本方法会同步
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

  /**
   * 订阅活跃执行数量，并立即收到当前快照。唯一的订阅方是 Server 后台
   * 维护调度；notifyListeners/notifyListener 是它的扇出与单播辅助。
   */
  subscribe(listener: (activeCount: number) => void): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) {
      this.notifyListener(listener);
    }
  }

  private notifyListener(listener: (activeCount: number) => void): void {
    try {
      listener(this.executions.size);
    } catch {
      // 后台负载观察者不是执行生命周期的一部分，失败不能回滚注册或释放。
    }
  }

  private notifyIdle(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId);
    if (!waiters) return;
    this.idleWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  }
}
