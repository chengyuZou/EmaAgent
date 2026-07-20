// 统一收敛 Live2D 动作拒绝与渲染故障，避免未处理 Promise 和逐帧错误风暴。
import type { Live2DError } from '../types.js';

const RECOVERABLE_ERROR_INTERVAL_MS = 5_000;

export interface Live2DRuntimeFaultBoundaryOptions {
  emit(error: Live2DError): void;
  stopRendering(): void;
  now?: () => number;
}

export interface Live2DRuntimeFaultBoundary {
  captureMotion(run: () => Promise<unknown>, source: string): void;
  tripRender(cause: unknown): void;
  isRenderCircuitOpen(): boolean;
}

export function createLive2DRuntimeFaultBoundary(
  options: Live2DRuntimeFaultBoundaryOptions,
): Live2DRuntimeFaultBoundary {
  const now = options.now ?? Date.now;
  const lastRecoverableErrorAt = new Map<string, number>();
  let renderCircuitOpen = false;

  function emitRecoverable(error: Live2DError, key: string): void {
    const currentTime = now();
    const previousTime = lastRecoverableErrorAt.get(key);
    if (previousTime !== undefined && currentTime - previousTime < RECOVERABLE_ERROR_INTERVAL_MS) return;
    lastRecoverableErrorAt.set(key, currentTime);
    options.emit(error);
  }

  function captureMotion(run: () => Promise<unknown>, source: string): void {
    try {
      void run().catch((cause: unknown) => {
        emitRecoverable({
          kind: 'motion_failed',
          phase: 'motion',
          message: `Live2D motion failed (${source}): ${errorMessage(cause)}`,
          cause,
          recoverable: true,
        }, `motion:${source}:${errorMessage(cause)}`);
      });
    } catch (cause) {
      emitRecoverable({
        kind: 'motion_failed',
        phase: 'motion',
        message: `Live2D motion failed (${source}): ${errorMessage(cause)}`,
        cause,
        recoverable: true,
      }, `motion:${source}:${errorMessage(cause)}`);
    }
  }

  function tripRender(cause: unknown): void {
    if (renderCircuitOpen) return;
    renderCircuitOpen = true;
    options.stopRendering();
    options.emit({
      kind: 'render_failed',
      phase: 'rendering',
      message: `Live2D rendering stopped: ${errorMessage(cause)}`,
      cause,
      recoverable: false,
    });
  }

  return {
    captureMotion,
    tripRender,
    isRenderCircuitOpen: () => renderCircuitOpen,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
