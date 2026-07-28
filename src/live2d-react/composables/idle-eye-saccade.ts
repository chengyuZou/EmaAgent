// 空闲时眼球的随机扫视,模拟真人"碎看为主、偶尔停留"的自然眼动。
//
// Final-stage 插件,只在 idle 动作且鼠标静止一段时间后运行。
// 鼠标活动时由 mouse-track(pre)主导视线;静止后本插件在 final 阶段覆盖,
// 让眼珠随机扫视而不是钉在最后的鼠标位置。
import type { DisposableMotionPlugin } from './motion-manager.js';
import { frameRateIndependentFactor } from './frame-timing.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

/** 眼珠向扫视目标逼近的 lerp 系数(60FPS 基准)。 */
const SACCADE_LERP = 0.3;
/** 鼠标静止超过该毫秒数才开始扫视。 */
const MOUSE_IDLE_THRESHOLD_MS = 2500;

/**
 * 扫视间隔的非均匀分布(累积概率, 基准间隔 ms)。
 * 短间隔概率高、长间隔概率低,模拟真人扫视"碎看为主、偶尔停留"。
 */
const SACCADE_INTERVAL_P: ReadonlyArray<readonly [number, number]> = [
  [0.4, 400],
  [0.7, 800],
  [0.85, 1400],
  [0.95, 2200],
  [1.0, 3600],
];
const SACCADE_INTERVAL_STEP_MS = 400;

function randomSaccadeIntervalMs(): number {
  const r = Math.random();
  for (const [p, base] of SACCADE_INTERVAL_P) {
    if (r <= p) return base + Math.random() * SACCADE_INTERVAL_STEP_MS;
  }
  return 3600 + Math.random() * SACCADE_INTERVAL_STEP_MS;
}

export function createIdleEyeSaccadePlugin(): DisposableMotionPlugin {
  // 鼠标静止累计时间;初始视为已静止(模型加载即可扫视)。
  let mouseIdleMs = MOUSE_IDLE_THRESHOLD_MS;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let saccadeElapsedMs = 0;
  let nextSaccadeInMs = randomSaccadeIntervalMs();

  const onMouseMove = (): void => { mouseIdleMs = 0; };
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', onMouseMove);
  }

  const plugin = ((ctx) => {
    if (!ctx.isIdleMotion) return;

    mouseIdleMs += ctx.timing.deltaMs;
    // 鼠标最近动过:让 mouse-track 主导,不扫视。
    if (mouseIdleMs < MOUSE_IDLE_THRESHOLD_MS) return;

    saccadeElapsedMs += ctx.timing.deltaMs;
    if (saccadeElapsedMs >= nextSaccadeInMs) {
      // X∈[-0.5,0.5];Y∈[-0.5,0.35](向下收敛,避免翻白眼感)。
      targetX = (Math.random() * 2 - 1) * 0.5;
      targetY = (Math.random() * 1.7 - 1) * 0.5;
      saccadeElapsedMs = 0;
      nextSaccadeInMs = randomSaccadeIntervalMs();
    }

    const factor = frameRateIndependentFactor(SACCADE_LERP, ctx.timing.deltaMs);
    currentX += (targetX - currentX) * factor;
    currentY += (targetY - currentY) * factor;
    ctx.model.setParameterValueById(ctx.paramNames.eyeBallXParam, currentX);
    ctx.model.setParameterValueById(ctx.paramNames.eyeBallYParam, currentY);
  }) as DisposableMotionPlugin;

  plugin.dispose = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', onMouseMove);
    }
  };
  return plugin;
}
