// 测试启动恢复覆盖中断任务，并完整遍历孤儿文件扫描所需的 Turn 游标页。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@ema-agent/ids';
import type { StartupTurnReader } from '../src/background/startupRecovery.js';
import {
  collectLiveTurnIds,
  StartupRecovery,
} from '../src/background/startupRecovery.js';

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

describe('StartupRecovery', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('在后台 Worker 启动前恢复各领域的中断状态', () => {
    const activeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-startup-'));
    directories.push(activeDataDir);
    const memory = {
      runStartupRecovery: vi.fn(() => ({
        resetTasks: 0,
        pendingSessions: 0,
        staleNodeEmbeds: 0,
        staleItemEmbeds: 0,
        orphanLazyUpdates: 0,
      })),
    };
    const session = {
      listTurnIdsPage: vi.fn(() => ({ ids: [], nextCursor: null })),
      recoverStuckTurns: vi.fn(() => ({ healed: 0 })),
    };
    const agentRuns = {
      recoverInterrupted: vi.fn(() => []),
    };
    const toolExecutions = {
      recoverInterrupted: vi.fn(() => []),
    };

    new StartupRecovery(
      activeDataDir,
      memory,
      session,
      agentRuns,
      toolExecutions,
    ).run();

    expect(toolExecutions.recoverInterrupted).toHaveBeenCalledTimes(1);
    expect(memory.runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(session.recoverStuckTurns).toHaveBeenCalledTimes(1);
    expect(agentRuns.recoverInterrupted).toHaveBeenCalledTimes(1);
  });
});
