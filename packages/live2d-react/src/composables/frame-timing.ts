// 把 Cubism motion-manager 的秒时间戳转换为受限、单调的插件帧时间。
const MAX_FRAME_DELTA_MS = 100;
const BASE_FRAME_MS = 1_000 / 60;

export interface FrameTiming {
  deltaMs: number;
  elapsedMs: number;
}

export class FrameClock {
  private lastNowSec: number | null = null;
  private elapsedMs = 0;

  advance(nowSec: number): FrameTiming {
    if (!Number.isFinite(nowSec)) {
      return { deltaMs: 0, elapsedMs: this.elapsedMs };
    }

    if (this.lastNowSec === null) {
      this.lastNowSec = nowSec;
      return { deltaMs: 0, elapsedMs: this.elapsedMs };
    }

    const rawDeltaMs = (nowSec - this.lastNowSec) * 1_000;
    this.lastNowSec = nowSec;
    const deltaMs = Math.min(MAX_FRAME_DELTA_MS, Math.max(0, rawDeltaMs));
    this.elapsedMs += deltaMs;
    return { deltaMs, elapsedMs: this.elapsedMs };
  }
}

/** 把“60 FPS 下每帧系数”转换为任意帧间隔下的等效平滑系数。 */
export function frameRateIndependentFactor(factorAt60Fps: number, deltaMs: number): number {
  if (deltaMs <= 0) return 0;
  const safeFactor = Math.min(1, Math.max(0, factorAt60Fps));
  return 1 - Math.pow(1 - safeFactor, deltaMs / BASE_FRAME_MS);
}
