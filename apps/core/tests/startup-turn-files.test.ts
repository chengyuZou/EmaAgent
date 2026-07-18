// 测试启动孤儿文件扫描会遍历全部 Turn 游标页，不会在固定数量上限处截断。
import { describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@ema-agent/contracts';
import type { StartupTurnReader } from '../src/wiring/startup-turn-files.js';
import { collectLiveTurnIds } from '../src/wiring/startup-turn-files.js';

describe('collectLiveTurnIds', () => {
  it('持续读取到 nextCursor 为空并汇总所有页面', () => {
    const listTurnIdsPage = vi.fn<StartupTurnReader['listTurnIdsPage']>()
      .mockReturnValueOnce({
        ids: ['turn-3', 'turn-2'],
        nextCursor: { startedAt: 20, id: 'turn-2' },
      })
      .mockReturnValueOnce({ ids: ['turn-1'], nextCursor: null });

    const result = collectLiveTurnIds(
      { listTurnIdsPage },
      'session-1' as SessionId,
    );

    expect(result).toEqual(new Set(['turn-3', 'turn-2', 'turn-1']));
    expect(listTurnIdsPage).toHaveBeenNthCalledWith(1, 'session-1', undefined);
    expect(listTurnIdsPage).toHaveBeenNthCalledWith(2, 'session-1', {
      startedAt: 20,
      id: 'turn-2',
    });
  });
});
