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

  /** 丢弃上一帧采样点，恢复后的首帧只重新建立时间基准。 */
  reset(): void {
    this.lastNowSec = null;
  }

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

/**
 * 将 Cubism 的绝对时间转换为“仅在舞台运行时推进”的时间轴。
 * 输出保持首次时间戳的原始量级，因此原生 motion 的起始时间契约不变。
 */
export class ActiveFrameTimeline {
  private lastSourceNowSec: number | null = null;
  private activeNowSec: number | null = null;
  private suspended = false;

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    this.lastSourceNowSec = null;
  }

  advance(sourceNowSec: number): number {
    if (!Number.isFinite(sourceNowSec)) {
      return this.activeNowSec ?? 0;
    }

    if (this.activeNowSec === null) {
      this.activeNowSec = sourceNowSec;
      this.lastSourceNowSec = sourceNowSec;
      return sourceNowSec;
    }

    if (this.lastSourceNowSec === null) {
      this.lastSourceNowSec = sourceNowSec;
      return this.activeNowSec;
    }

    const sourceDeltaSec = Math.max(0, sourceNowSec - this.lastSourceNowSec);
    this.lastSourceNowSec = sourceNowSec;
    if (!this.suspended) this.activeNowSec += sourceDeltaSec;
    return this.activeNowSec;
  }
}

/** 把“60 FPS 下每帧系数”转换为任意帧间隔下的等效平滑系数。 */
export function frameRateIndependentFactor(factorAt60Fps: number, deltaMs: number): number {
  if (deltaMs <= 0) return 0;
  const safeFactor = Math.min(1, Math.max(0, factorAt60Fps));
  return 1 - Math.pow(1 - safeFactor, deltaMs / BASE_FRAME_MS);
}
