// 以 Session 和 Turn 双重身份记录当前活动根 Turn，避免迟到清理误伤后继执行。

import type { SessionId, TurnId } from '@ema-agent/ids';

interface ActiveTurn {
  turnId: TurnId;
  abortController: AbortController;
}

/**
 * 运行态只用于快速判断和取消；崩溃恢复仍以 SQLite 中的 Turn 终态为准。
 * 所有改变已有条目的操作都必须携带 TurnId，防止旧执行流清理同 Session 的新 Turn。
 */
export class ActiveTurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly listeners = new Set<(activeCount: number) => void>();

  /** 注册活动 Turn；同一 Session 已有运行项时拒绝覆盖。 */
  register(sessionId: SessionId, turnId: TurnId): AbortSignal {
    const key = sessionId as string;
    if (this.turns.has(key)) {
      throw new Error(`active_turn_already_registered: ${sessionId}`);
    }

    const abortController = new AbortController();
    this.turns.set(key, { turnId, abortController });
    this.notifyListeners();
    return abortController.signal;
  }

  /** 只取消身份匹配的活动 Turn；迟到请求不会影响后继 Turn。 */
  abort(sessionId: SessionId, turnId: TurnId): boolean {
    const active = this.turns.get(sessionId as string);
    if (!active || active.turnId !== turnId) return false;
    active.abortController.abort();
    return true;
  }

  isRunning(sessionId: SessionId): boolean {
    return this.turns.has(sessionId as string);
  }

  getActiveTurnId(sessionId: SessionId): TurnId | undefined {
    return this.turns.get(sessionId as string)?.turnId;
  }

  /** 只清除身份匹配的活动 Turn；返回 false 表示条目已更换或不存在。 */
  clear(sessionId: SessionId, turnId: TurnId): boolean {
    const key = sessionId as string;
    const active = this.turns.get(key);
    if (!active || active.turnId !== turnId) return false;
    this.turns.delete(key);
    this.notifyListeners();
    return true;
  }

  /** Session 永久删除时丢弃运行态；普通 Turn 终态不得使用该入口。 */
  discardSession(sessionId: SessionId): boolean {
    if (!this.turns.delete(sessionId as string)) return false;
    this.notifyListeners();
    return true;
  }

  activeSessionCount(): number {
    return this.turns.size;
  }

  /** 订阅活动根 Turn 数量，并立即收到当前快照。 */
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
      listener(this.turns.size);
    } catch {
      // 后台负载观察者不是 Turn 生命周期的一部分，失败不能回滚注册或释放。
    }
  }
}
