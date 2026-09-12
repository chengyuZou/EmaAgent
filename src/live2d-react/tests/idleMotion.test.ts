// 测试待机播放只使用显式候选，并在动作结束后无空档接力。

import type { Cubism4MotionManager } from 'pixi-live2d-display/cubism4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLive2DIdleMotionPlayback } from '../idleMotion.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createMotionManager() {
  let finishListener: (() => void) | null = null;
  const off = vi.fn();
  const manager = {
    playing: false,
    on(event: string, listener: () => void) {
      if (event === 'motionFinish') finishListener = listener;
    },
    off,
  } as unknown as Cubism4MotionManager;

  return {
    manager,
    off,
    finish() {
      manager.playing = false;
      finishListener?.();
    },
  };
}

function captureAnimationFrame() {
  let callback: FrameRequestCallback | null = null;
  const request = vi.fn((next: FrameRequestCallback) => {
    callback = next;
    return 1;
  });
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);

  return {
    request,
    cancel,
    run() {
      const next = callback;
      callback = null;
      next?.(0);
    },
  };
}

describe('startLive2DIdleMotionPlayback', () => {
  it('立即播放显式候选，并在结束后的下一帧继续播放', async () => {
    const motionManager = createMotionManager();
    const frame = captureAnimationFrame();
    const play = vi.fn().mockResolvedValue(true);
    const playback = startLive2DIdleMotionPlayback(
      motionManager.manager,
      play,
      () => [{ group: 'Idle', index: 0 }],
      () => true,
    );

    expect(play).toHaveBeenCalledWith({ group: 'Idle', index: 0 });
    await Promise.resolve();
    await Promise.resolve();
    motionManager.finish();
    expect(frame.request).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();

    frame.run();
    expect(play).toHaveBeenCalledTimes(2);
    playback.dispose();
  });

  it('暂停时不接力，恢复后由调用方继续待机', async () => {
    const motionManager = createMotionManager();
    const frame = captureAnimationFrame();
    const play = vi.fn().mockResolvedValue(true);
    let enabled = false;
    const playback = startLive2DIdleMotionPlayback(
      motionManager.manager,
      play,
      () => [{ group: 'Idle', index: 0 }],
      () => enabled,
    );

    expect(play).not.toHaveBeenCalled();
    enabled = true;
    playback.resume();
    expect(play).toHaveBeenCalledOnce();

    await Promise.resolve();
    await Promise.resolve();
    enabled = false;
    motionManager.finish();
    frame.run();
    expect(play).toHaveBeenCalledOnce();

    enabled = true;
    playback.resume();
    expect(play).toHaveBeenCalledTimes(2);
    playback.dispose();
  });

  it('释放时取消待执行帧并解绑结束事件', async () => {
    const motionManager = createMotionManager();
    const frame = captureAnimationFrame();
    const play = vi.fn().mockResolvedValue(true);
    const playback = startLive2DIdleMotionPlayback(
      motionManager.manager,
      play,
      () => [{ group: 'Idle', index: 0 }],
      () => true,
    );

    await Promise.resolve();
    await Promise.resolve();
    motionManager.finish();
    playback.dispose();

    expect(frame.cancel).toHaveBeenCalledWith(1);
    expect(motionManager.off).toHaveBeenCalledWith(
      'motionFinish',
      expect.any(Function),
    );
  });
});
