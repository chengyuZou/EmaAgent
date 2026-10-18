const MIN_GAZE_INTERVAL_MS = 1_000;
const MAX_GAZE_INTERVAL_MS = 4_500;
const GAZE_RANGE_X = 0.9;
const GAZE_RANGE_Y_MIN = -0.5;
const GAZE_RANGE_Y_MAX = 0.6;

/**
 * setFocus 接收 [-1, 1] 归一化坐标, 平滑转动由 FocusController 完成.
 * 每次定时检查 canGaze, 鼠标活动时跳过本次更新, 不覆盖鼠标设置的目标.
 */
export function startLive2DIdleGaze(
  setFocus: (x: number, y: number) => void,
  canGaze: () => boolean,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const delay = MIN_GAZE_INTERVAL_MS
      + Math.random() * (MAX_GAZE_INTERVAL_MS - MIN_GAZE_INTERVAL_MS);
    timer = setTimeout(() => {
      if (canGaze()) {
        const x = (Math.random() * 2 - 1) * GAZE_RANGE_X;
        const y = GAZE_RANGE_Y_MIN
          + Math.random() * (GAZE_RANGE_Y_MAX - GAZE_RANGE_Y_MIN);
        setFocus(x, y);
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
