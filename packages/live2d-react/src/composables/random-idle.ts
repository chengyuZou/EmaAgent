// ── RandomIdleMotionScheduler ─────────────────────────────────────────────────
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
  motionCount: number;
  group: string;
  minDelayMs: number;
  maxDelayMs: number;
  readEnabled(): boolean;
}

export function startRandomIdleScheduler(options: RandomIdleSchedulerOptions): () => void {
  const { playMotion, motionCount, group, minDelayMs, maxDelayMs, readEnabled } = options;
  if (motionCount === 0) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    const ms = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
    timer = setTimeout(() => {
      if (readEnabled()) {
        const idx = Math.floor(Math.random() * motionCount);
        playMotion(group, idx);
      }
      schedule(); // next
    }, ms);
  }

  schedule();

  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}
