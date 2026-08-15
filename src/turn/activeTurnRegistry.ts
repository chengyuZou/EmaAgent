// 以 Session 和 Turn 双重身份记录当前活动根 Turn

import type { SessionId, TurnId } from '@ema-agent/ids';
import { ActiveTurnAlreadyRegisteredError } from './errors.js';

interface ActiveTurn {
  turnId: TurnId;
  abortController: AbortController;
}

export class ActiveTurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>();
  /**
   * 订阅方是 Server 的后台维护调度：低优先级维护只在无前台 Turn 时运行，
   * 订阅让最后一个 Turn 结束时后台立刻被唤醒，而不是轮询空转。
   */
  private readonly listeners = new Set<(activeCount: number) => void>();

  register(sessionId: SessionId, turnId: TurnId): AbortSignal {
    const key = sessionId as string;
    if (this.turns.has(key)) {
      throw new ActiveTurnAlreadyRegisteredError(sessionId as string);
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

  /**
   * 订阅活动根 Turn 数量，并立即收到当前快照。唯一的订阅方是 Server 后台
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
      listener(this.turns.size);
    } catch {
      // 后台负载观察者不是 Turn 生命周期的一部分，失败不能回滚注册或释放。
    }
  }
}
