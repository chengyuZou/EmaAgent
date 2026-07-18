// 测试草稿清理所依赖的 Turn 创建确认只会结算一次。
import { describe, expect, it } from 'vitest';

import { createTurnAcceptance } from '../src/lib/turn-acceptance.js';

describe('createTurnAcceptance', () => {
  it('后端创建 Turn 后解除等待', async () => {
    const acceptance = createTurnAcceptance<string>();
    acceptance.accept('turn-1');

    await expect(acceptance.promise).resolves.toBe('turn-1');
  });

  it('创建失败时保留拒绝原因且忽略迟到的成功', async () => {
    const acceptance = createTurnAcceptance<string>();
    const failure = new Error('create failed');
    acceptance.reject(failure);
    acceptance.accept('late-turn');

    await expect(acceptance.promise).rejects.toBe(failure);
  });
});
