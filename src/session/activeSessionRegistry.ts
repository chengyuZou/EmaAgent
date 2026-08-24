// 同 Session 一个活跃执行：当前唯一占用者是根 Turn；commands 批的手动 compact
// 复用同一坑位（kind 标签届时再加）。归 session 包：它守的是 Session 级执行互斥，
// 不是 Turn 的内部状态。

import { ActiveSessionAlreadyRegisteredError } from './errors.js';

interface ActiveExecution {
  executionId: string;
  abortController: AbortController;
}

export class ActiveSessionRegistry {
  private readonly executions = new Map<string, ActiveExecution>();
  /**
   * 订阅方是 Server 的后台维护调度：低优先级维护只在无前台执行时运行，
   * 订阅让最后一个执行结束时后台立刻被唤醒，而不是轮询空转。
   */
  private readonly listeners = new Set<(activeCount: number) => void>();

  register(sessionId: string, executionId: string): AbortSignal {
    if (this.executions.has(sessionId)) {
      throw new ActiveSessionAlreadyRegisteredError(sessionId);
    }

    const abortController = new AbortController();
    this.executions.set(sessionId, { executionId, abortController });
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

  getActiveExecutionId(sessionId: string): string | undefined {
    return this.executions.get(sessionId)?.executionId;
  }

  /** 只清除身份匹配的活跃执行；返回 false 表示条目已更换或不存在。 */
  clear(sessionId: string, executionId: string): boolean {
    const active = this.executions.get(sessionId);
    if (!active || active.executionId !== executionId) return false;
    this.executions.delete(sessionId);
    this.notifyListeners();
    return true;
  }

  /** Session 永久删除时丢弃运行态；普通执行终态不得使用该入口。 */
  discardSession(sessionId: string): boolean {
    if (!this.executions.delete(sessionId)) return false;
    this.notifyListeners();
    return true;
  }

  activeSessionCount(): number {
    return this.executions.size;
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
}
