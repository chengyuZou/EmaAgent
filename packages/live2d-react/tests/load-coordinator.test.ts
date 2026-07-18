// 测试 Live2D 异步加载换代、取消与资源归属隔离。
import { describe, expect, it } from 'vitest';

import { Live2DLoadCoordinator } from '../src/composables/load-coordinator.js';

describe('Live2DLoadCoordinator', () => {
  it('开始新加载时使旧加载失效并发出取消信号', () => {
    const coordinator = new Live2DLoadCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.isCurrent()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('旧加载迟到的清理不会取消当前加载', () => {
    const coordinator = new Live2DLoadCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    first.cancel();

    expect(second.isCurrent()).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('取消当前加载后禁止其继续发布结果', () => {
    const coordinator = new Live2DLoadCoordinator();
    const current = coordinator.begin();

    current.cancel();

    expect(current.isCurrent()).toBe(false);
    expect(current.signal.aborted).toBe(true);
  });

  it('旧异步任务晚于新任务完成时不会发布过期结果', async () => {
    const coordinator = new Live2DLoadCoordinator();
    const first = coordinator.begin();
    let finishFirst: (() => void) | undefined;
    let published = false;
    const waitForFirst = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const staleTask = (async () => {
      await waitForFirst;
      if (first.isCurrent()) published = true;
    })();

    coordinator.begin();
    finishFirst?.();
    await staleTask;

    expect(published).toBe(false);
  });
});
