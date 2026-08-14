// 根据全局根 Turn 活动时间判断低优先级后台维护是否可以开始。

export const LIGHT_MAINTENANCE_IDLE_MS = 60_000;
export const HEAVY_MAINTENANCE_IDLE_MS = 30 * 60_000;

export class WorkloadIdlePolicy {
  private lastForegroundActivityAt: number;

  constructor(nowMs = Date.now()) {
    this.lastForegroundActivityAt = nowMs;
  }

  /** Turn 开始和结束都重置计时，长 Turn 结束后不会立刻被误判为空闲。 */
  recordForegroundActivity(nowMs = Date.now()): void {
    this.lastForegroundActivityAt = nowMs;
  }

  canRun(
    hasActiveTurns: boolean,
    minimumIdleMs: number,
    nowMs = Date.now(),
  ): boolean {
    if (hasActiveTurns) return false;
    return nowMs - this.lastForegroundActivityAt >= minimumIdleMs;
  }
}
