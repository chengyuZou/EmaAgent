// 记录当前活动根 Turn，并向后台维护发布全局前台负载变化。

import type { SessionId, TurnId } from '@ema-agent/ids';

interface ActiveRun {
  turnId: TurnId;
  abortController: AbortController;
}

/**
 * 内存态仅用于快速判断与取消当前 Turn；崩溃恢复仍以 SQLite 中的 Turn 终态为准，
 * 启动时由 SessionStore 修复遗留的 running 记录。
 */
export class RunRegistry {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly listeners = new Set<(activeCount: number) => void>();

  /** 注册活动 Turn，并返回供 LLM 与 Tool 链路共同消费的取消信号。 */
  register(sessionId: SessionId, turnId: TurnId): AbortSignal {
    const abortController = new AbortController();
    this.runs.set(sessionId as string, { turnId, abortController });
    this.notifyListeners();
    return abortController.signal;
  }

  /** 取消 Session 当前 Turn；没有活动 Turn 时幂等返回 false。 */
  abort(sessionId: SessionId): boolean {
    const run = this.runs.get(sessionId as string);
    if (!run) return false;
    run.abortController.abort();
    return true;
  }

  isRunning(sessionId: SessionId): boolean {
    return this.runs.has(sessionId as string);
  }

  getActiveTurnId(sessionId: SessionId): TurnId | undefined {
    return this.runs.get(sessionId as string)?.turnId;
  }

  /** Turn 进入 completed、failed 或 aborted 后清除内存态。 */
  clear(sessionId: SessionId): void {
    if (!this.runs.delete(sessionId as string)) return;
    this.notifyListeners();
  }

  /** 返回当前活动根 Turn 数量。 */
  activeSessionCount(): number {
    return this.runs.size;
  }

  /**
   * 观察活动根 Turn 数量；立即发送当前快照，避免订阅方在启动与第一次变化之间
   * 误判系统空闲。
   */
  subscribe(listener: (activeCount: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.runs.size);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.runs.size);
    }
  }
}
