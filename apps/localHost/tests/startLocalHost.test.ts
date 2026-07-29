// 测试 LocalHost 先完成必需恢复，再跟踪可降级启动任务并有序关闭。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalHostLifecycle } from '../src/bootstrap/startLocalHost.js';

describe('LocalHostLifecycle', () => {
  const originalProfileDir = process.env['EMA_PROFILE_DIR'];
  const directories: string[] = [];

  afterEach(() => {
    if (originalProfileDir === undefined) {
      delete process.env['EMA_PROFILE_DIR'];
    } else {
      process.env['EMA_PROFILE_DIR'] = originalProfileDir;
    }
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('必需恢复先完成，可降级任务后台启动且重复 start 只执行一次', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-profile-'));
    directories.push(profileDir);
    process.env['EMA_PROFILE_DIR'] = profileDir;
    const order: string[] = [];
    const knowledge = {
      ensureDefault: vi.fn(async () => {
        order.push('knowledge.ensure');
      }),
    };
    const skills = {
      scanAndReconcile: vi.fn(async () => {
        order.push('skills');
        return { indexed: 0, pruned: 0, errors: [] };
      }),
    };
    const modelCatalog = {
      refresh: vi.fn(async () => {
        order.push('catalog');
        return {};
      }),
      size: 1,
    };
    const marketplace = {
      ensureSeeds: vi.fn(() => {
        order.push('marketplace');
      }),
    };
    const providerRuntime = {
      syncBridge: vi.fn(async () => {
        order.push('bridge');
      }),
    };
    const backgroundWork = {
      start: vi.fn(() => {
        order.push('background');
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const lifecycle = new LocalHostLifecycle(
      knowledge,
      marketplace,
      skills,
      modelCatalog,
      providerRuntime,
      backgroundWork,
    );

    await Promise.all([lifecycle.start(), lifecycle.start()]);
    await vi.waitFor(() => {
      expect(providerRuntime.syncBridge).toHaveBeenCalledTimes(1);
    });

    expect(knowledge.ensureDefault).toHaveBeenCalledWith(
      path.join(profileDir, 'kb-default'),
    );
    expect(order).toEqual([
      'background',
      'marketplace',
      'knowledge.ensure',
      'skills',
      'catalog',
      'bridge',
    ]);
    expect(backgroundWork.start).toHaveBeenCalledTimes(1);
    expect(marketplace.ensureSeeds).toHaveBeenCalledTimes(1);
    expect(skills.scanAndReconcile).toHaveBeenCalledTimes(1);
    expect(modelCatalog.refresh).toHaveBeenCalledTimes(1);
    expect(providerRuntime.syncBridge).toHaveBeenCalledTimes(1);

    await lifecycle.shutdown();
    expect(backgroundWork.shutdown).toHaveBeenCalledTimes(1);
  });

  it('可选初始化失败只降级对应能力，不让 start 失败', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-profile-'));
    directories.push(profileDir);
    process.env['EMA_PROFILE_DIR'] = profileDir;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lifecycle = new LocalHostLifecycle(
      {
        ensureDefault: vi.fn(async () => {
          throw new Error('kb unavailable');
        }),
      },
      {
        ensureSeeds: vi.fn(() => {
          throw new Error('marketplace unavailable');
        }),
      },
      {
        scanAndReconcile: vi.fn(async () => {
          throw new Error('skill unavailable');
        }),
      },
      {
        refresh: vi.fn(async () => null),
        size: 0,
      },
      {
        syncBridge: vi.fn(async () => {
          throw new Error('bridge unavailable');
        }),
      },
      {
        start: vi.fn(),
        shutdown: vi.fn(async () => undefined),
      },
    );

    await expect(lifecycle.start()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(5);
    });
    warn.mockRestore();
  });

  it('必需恢复失败会让 start 拒绝，且不启动任何可降级任务', async () => {
    const knowledge = { ensureDefault: vi.fn(async () => undefined) };
    const marketplace = { ensureSeeds: vi.fn() };
    const skills = {
      scanAndReconcile: vi.fn(async () => ({
        indexed: 0,
        pruned: 0,
        errors: [],
      })),
    };
    const modelCatalog = {
      refresh: vi.fn(async () => ({})),
      size: 1,
    };
    const providerRuntime = { syncBridge: vi.fn(async () => undefined) };
    const backgroundWork = {
      start: vi.fn(() => {
        throw new Error('required recovery failed');
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const lifecycle = new LocalHostLifecycle(
      knowledge,
      marketplace,
      skills,
      modelCatalog,
      providerRuntime,
      backgroundWork,
    );

    await expect(lifecycle.start()).rejects.toThrow('required recovery failed');
    expect(knowledge.ensureDefault).not.toHaveBeenCalled();
    expect(marketplace.ensureSeeds).not.toHaveBeenCalled();
    expect(skills.scanAndReconcile).not.toHaveBeenCalled();
    expect(modelCatalog.refresh).not.toHaveBeenCalled();
    expect(providerRuntime.syncBridge).not.toHaveBeenCalled();
  });
});
