// 调度 LocalHost 的周期性后台任务，包括记忆维护、文件清扫与 Bridge 心跳。

/**
 * Single-flight 周期任务(B-025):
 * 上一轮还没跑完时本轮直接跳过——慢 tick 不叠罗汉, 清扫/心跳自然顺延不重复处理;
 * stop() 清掉定时器并等在途轮落地, 关机顺序才有"先停生产、再 drain"的保证。
 */
export interface BackgroundTickDeps {
  /** 每轮执行的任务; tickCount 从 1 开始递增(含被跳过的轮次由调用方决定语义)。 */
  onTick: (tickCount: number) => Promise<void>;
  intervalMs: number;
}

export interface BackgroundTicker {
  /** 停止后续轮次, 并等在途轮落地。可重复调用。 */
  stop(): Promise<void>;
}

export function createBackgroundTicker(deps: BackgroundTickDeps): BackgroundTicker {
  let tickCount = 0;
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (inFlight) return;   // 上轮未完成, 本轮跳过(不叠罗汉)
    tickCount++;
    inFlight = deps.onTick(tickCount)
      .catch((err) => console.warn('[background-tick] tick failed:', err))
      .finally(() => { inFlight = null; });
  }, deps.intervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await inFlight;
    },
  };
}
