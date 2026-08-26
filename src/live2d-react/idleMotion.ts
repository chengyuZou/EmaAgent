// 从 Character 明确允许的 Motion 中定时选择待机动作。

import type { Live2DMotionReference } from './types.js';

const MIN_IDLE_DELAY_MS = 12_000;
const MAX_IDLE_DELAY_MS = 35_000;

export function startLive2DIdleMotionSchedule(
  play: (motion: Live2DMotionReference) => void,
  readMotions: () => readonly Live2DMotionReference[],
  canPlay: () => boolean,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const delay = MIN_IDLE_DELAY_MS
      + Math.random() * (MAX_IDLE_DELAY_MS - MIN_IDLE_DELAY_MS);
    timer = setTimeout(() => {
      const motions = readMotions();
      if (canPlay() && motions.length > 0) {
        const motion = motions[Math.floor(Math.random() * motions.length)];
        if (motion) play(motion);
      }
      schedule();
    }, delay);
  };

  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
