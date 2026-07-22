// 按当前运行配置调度可暂停、可热更新的 Live2D 随机待机动作。
//
// When the model is loaded and the character is not speaking, plays a random
// Idle-group motion every 12–35 seconds.
//
// Not a pipeline plugin — runs on a setInterval outside the per-frame loop.
// Initialised from Live2DStage after the model is ready.

/**
 * Start the idle-motion scheduler. Returns a cleanup function.
 */
export interface RandomIdleSchedulerOptions {
  playMotion(group: string, index?: number): void;
  readConfig(): RandomIdleSchedulerConfig;
  readEnabled(): boolean;
}

export interface RandomIdleSchedulerConfig {
  motionCount: number;
  group: string;
  minDelayMs: number;
  maxDelayMs: number;
}

export function startRandomIdleScheduler(options: RandomIdleSchedulerOptions): () => void {
  const { playMotion, readConfig, readEnabled } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    const { minDelayMs, maxDelayMs } = readConfig();
    const ms = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
    timer = setTimeout(() => {
      const { group, motionCount } = readConfig();
      if (readEnabled() && motionCount > 0) {
        const idx = Math.floor(Math.random() * motionCount);
        playMotion(group, idx);
      }
      schedule();
    }, ms);
  }

  schedule();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
