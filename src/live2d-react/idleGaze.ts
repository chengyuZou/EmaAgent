// 无鼠标活动时随机游移注视点，让模型视线保持活物感。
//
// 只写 FocusController 的归一化目标，平滑转动由库自带动量插值完成；鼠标活动会
// 直接覆盖同一个目标，因此天然让位，不需要与鼠标注视做状态互斥。

const MIN_GAZE_INTERVAL_MS = 1_000;
const MAX_GAZE_INTERVAL_MS = 4_500;
const GAZE_RANGE_X = 0.9;
const GAZE_RANGE_Y_MIN = -0.5;
const GAZE_RANGE_Y_MAX = 0.6;

/**
 * `setFocus` 接收 [-1,1] 归一化坐标；`canGaze` 由宿主决定是否无交互（如距上次
 * 鼠标活动超过阈值），每次到点都会重新询问，宿主让位无需通知本模块。
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
