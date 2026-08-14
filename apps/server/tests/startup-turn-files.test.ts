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
      sessionExists: vi.fn(() => true),
      listTurnIdsPage: vi.fn(() => ({ ids: [], nextCursor: null })),
      recoverStuckTurns: vi.fn(() => ({ healed: 0 })),
    };
    const agentRuns = {
      recoverInterrupted: vi.fn(() => []),
    };
    const toolExecutions = {
      recoverInterrupted: vi.fn(() => []),
    };
    const backgroundProcesses = {
      recoverInterrupted: vi.fn(() => []),
    };
    const characterResources = {
      recoverResourceFiles: vi.fn(() => ({
        restored: 1,
        removed: 2,
        failed: 0,
      })),
    };

    const recovery = new StartupRecovery(
      activeDataDir,
      memory,
      session,
      agentRuns,
      toolExecutions,
      backgroundProcesses,
      characterResources,
    );
    recovery.runRequired();
    expect(recovery.runMaintenance()).toEqual({ memoryReady: true });

    expect(toolExecutions.recoverInterrupted).toHaveBeenCalledTimes(1);
    expect(backgroundProcesses.recoverInterrupted).toHaveBeenCalledTimes(1);
    expect(memory.runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(session.recoverStuckTurns).toHaveBeenCalledTimes(1);
    expect(agentRuns.recoverInterrupted).toHaveBeenCalledTimes(1);
    expect(characterResources.recoverResourceFiles).toHaveBeenCalledTimes(1);
  });

  it('Turn 终态恢复失败时向上传播，不继续伪装 ready', () => {
    const activeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-startup-'));
    directories.push(activeDataDir);
    const recovery = new StartupRecovery(
      activeDataDir,
      {
        runStartupRecovery: vi.fn(() => ({
          resetTasks: 0,
          pendingSessions: 0,
          staleNodeEmbeds: 0,
          staleItemEmbeds: 0,
          orphanLazyUpdates: 0,
        })),
      },
      {
        sessionExists: vi.fn(() => true),
        listTurnIdsPage: vi.fn(() => ({ ids: [], nextCursor: null })),
        recoverStuckTurns: vi.fn(() => {
          throw new Error('database unavailable');
        }),
      },
      { recoverInterrupted: vi.fn(() => []) },
      { recoverInterrupted: vi.fn(() => []) },
      { recoverInterrupted: vi.fn(() => []) },
      {
        recoverResourceFiles: vi.fn(() => ({
          restored: 0,
          removed: 0,
          failed: 0,
        })),
      },
    );

    expect(() => recovery.runRequired()).toThrow('database unavailable');
  });

  it('Memory 恢复失败会返回降级状态而不影响文件维护', () => {
    const activeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-startup-'));
    directories.push(activeDataDir);
    const recovery = new StartupRecovery(
      activeDataDir,
      {
        runStartupRecovery: vi.fn(() => {
          throw new Error('memory unavailable');
        }),
      },
      {
        sessionExists: vi.fn(() => true),
        listTurnIdsPage: vi.fn(() => ({ ids: [], nextCursor: null })),
        recoverStuckTurns: vi.fn(() => ({ healed: 0 })),
      },
      { recoverInterrupted: vi.fn(() => []) },
      { recoverInterrupted: vi.fn(() => []) },
      { recoverInterrupted: vi.fn(() => []) },
      {
        recoverResourceFiles: vi.fn(() => ({
          restored: 0,
          removed: 0,
          failed: 0,
        })),
      },
    );

    expect(recovery.runMaintenance()).toEqual({ memoryReady: false });
  });

  it('先删除数据库已不存在的 Session 目录，再扫描存活 Turn 文件', () => {
    const activeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-startup-'));
    directories.push(activeDataDir);
    const orphanDir = path.join(
      activeDataDir,
      'sessions',
      'session-orphan',
      'background-processes',
      'process-1',
    );
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'stdout.log'), 'orphan');
    const listTurnIdsPage = vi.fn(() => ({ ids: [], nextCursor: null }));
    const recovery = new StartupRecovery(
      activeDataDir,
      {
        runStartupRecovery: vi.fn(() => ({
          resetTasks: 0,
          pendingSessions: 0,
          staleNodeEmbeds: 0,
          staleItemEmbeds: 0,
          orphanLazyUpdates: 0,
        })),
      },
      {
        sessionExists: vi.fn(() => false),
        listTurnIdsPage,
        recoverStuckTurns: vi.fn(() => ({ healed: 0 })),
      },
      { recoverInterrupted: vi.fn(() => []) },
      { recoverInterrupted: vi.fn(() => []) },
      { recoverInterrupted: vi.fn(() => []) },
      {
        recoverResourceFiles: vi.fn(() => ({
          restored: 0,
          removed: 0,
          failed: 0,
        })),
      },
    );

    recovery.runMaintenance();

    expect(fs.existsSync(path.join(activeDataDir, 'sessions', 'session-orphan')))
      .toBe(false);
    expect(listTurnIdsPage).not.toHaveBeenCalled();
  });
});
