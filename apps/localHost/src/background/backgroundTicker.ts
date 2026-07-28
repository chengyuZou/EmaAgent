// 保证 LocalHost 周期任务单飞执行，并在关闭时等待在途轮次结束。

export interface BackgroundTickDependencies {
  /** tickCount 从 1 开始，只统计真正开始执行的轮次。 */
  onTick: (tickCount: number) => Promise<void>;
  intervalMs: number;
}

export interface BackgroundTicker {
  /** 停止后续轮次并等待在途任务结束；重复调用不会产生额外副作用。 */
  stop(): Promise<void>;
}

export function createBackgroundTicker(
  dependencies: BackgroundTickDependencies,
): BackgroundTicker {
  let tickCount = 0;
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (inFlight) return;
    tickCount++;
    inFlight = dependencies.onTick(tickCount)
      .catch((error) => console.warn('[background-tick] tick failed:', error))
      .finally(() => {
        inFlight = null;
      });
  }, dependencies.intervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await inFlight;
    },
  };
}
