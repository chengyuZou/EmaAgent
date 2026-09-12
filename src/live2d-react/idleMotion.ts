// 从 Character 明确允许的 Motion 中连续选择待机动作。

import type { Live2dMotion } from '@ema-agent/characters';
import type { Cubism4MotionManager } from 'pixi-live2d-display/cubism4';

type MotionFinishEmitter = {
  on(event: 'motionFinish', listener: () => void): void;
  off(event: 'motionFinish', listener: () => void): void;
};

export function startLive2DIdleMotionPlayback(
  motionManager: Cubism4MotionManager,
  play: (motion: Live2dMotion) => Promise<boolean>,
  readMotions: () => readonly Live2dMotion[],
  canPlay: () => boolean,
): { resume: () => void; dispose: () => void } {
  // 当前依赖会发出 motionFinish,但类型声明没有暴露继承自 EventEmitter 的 on/off。
  const finishEmitter = motionManager as Cubism4MotionManager & MotionFinishEmitter;
  let nextFrame: number | null = null;
  let starting = false;
  let disposed = false;

  const resume = (): void => {
    if (disposed || starting || motionManager.playing || !canPlay()) return;

    const motions = readMotions();
    const motion = motions[Math.floor(Math.random() * motions.length)];
    if (!motion) return;

    starting = true;
    void play(motion)
      .catch((error: unknown) => {
        console.warn('[live2d] 待机动作执行失败', motion.group, motion.index, error);
      })
      .finally(() => {
        starting = false;
      });
  };

  const handleMotionFinish = (): void => {
    if (disposed || nextFrame !== null) return;
    // motionFinish 在第三方状态清理前发出,下一帧启动才不会被随后执行的 complete() 清空。
    nextFrame = requestAnimationFrame(() => {
      nextFrame = null;
      resume();
    });
  };

  finishEmitter.on('motionFinish', handleMotionFinish);
  resume();

  return {
    resume,
    dispose() {
      disposed = true;
      finishEmitter.off('motionFinish', handleMotionFinish);
      if (nextFrame !== null) {
        cancelAnimationFrame(nextFrame);
        nextFrame = null;
      }
    },
  };
}
