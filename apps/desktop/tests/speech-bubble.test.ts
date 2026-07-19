// SpeechBubble 淡出控制器(F-030): 两个定时器都受控,
// 旧 turn 挂起的淡出回调不能清掉新 turn 的文本。
import { describe, expect, it, vi } from 'vitest';

// desktop-ui barrel 会经 tts-playback 拖入 live2d-react → pixi-live2d-display,
// 后者顶层访问 window, node 环境直接炸; 控制器不碰 tauriBridge, mock 掉即可。
vi.mock('@ema-agent/desktop-ui', () => ({
  tauriBridge: { listen: vi.fn() },
}));

import { createFadeController } from '../src/components/SpeechBubble.js';

const DELAY = 4000;
const OUT   = 600;

function makeController(): {
  controller: ReturnType<typeof createFadeController>;
  calls: string[];
} {
  const calls: string[] = [];
  const controller = createFadeController({
    fadeDelayMs: DELAY,
    fadeOutMs:   OUT,
    onFadeStart: () => calls.push('fade-start'),
    onFadeDone:  () => calls.push('fade-done'),
  });
  return { controller, calls };
}

describe('SpeechBubble fade controller', () => {
  it('完整流程: 延迟结束开始淡出, 淡出完成后隐藏清空', () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = makeController();
      controller.scheduleFade();

      vi.advanceTimersByTime(DELAY - 1);
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(calls).toEqual(['fade-start']);
      vi.advanceTimersByTime(OUT);
      expect(calls).toEqual(['fade-start', 'fade-done']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('淡出进行中新 turn 到来(clear): 旧回调不再触发', () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = makeController();
      controller.scheduleFade();
      vi.advanceTimersByTime(DELAY);
      expect(calls).toEqual(['fade-start']);

      // speech:start —— F-030 出事场景: 匿名内层 timer 清不掉, 到点误清新文本。
      controller.clear();
      vi.advanceTimersByTime(OUT * 2);
      expect(calls).toEqual(['fade-start']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('延迟等待期间 clear: 淡出不会开始', () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = makeController();
      controller.scheduleFade();
      vi.advanceTimersByTime(DELAY / 2);

      controller.clear();
      vi.advanceTimersByTime(DELAY * 2);
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('重复 speech:end 重排: 旧任务被取消, 以最后一次为准', () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = makeController();
      controller.scheduleFade();
      vi.advanceTimersByTime(DELAY / 2);

      controller.scheduleFade();
      vi.advanceTimersByTime(DELAY / 2 + 1);
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(DELAY / 2);
      expect(calls).toEqual(['fade-start']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear 后重新 schedule: 两轮世代互不干扰', () => {
    vi.useFakeTimers();
    try {
      const { controller, calls } = makeController();
      controller.scheduleFade();
      vi.advanceTimersByTime(DELAY);

      controller.clear();
      controller.scheduleFade();
      vi.advanceTimersByTime(DELAY + OUT);
      expect(calls).toEqual(['fade-start', 'fade-start', 'fade-done']);
    } finally {
      vi.useRealTimers();
    }
  });
});
