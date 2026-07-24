// 这里测试 Sandbox 只保护 Core 传入的真实私有路径，不再自行猜旧设置文件位置。

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxConfig } from '../config-builder.js';

describe('buildSandboxConfig 私有路径', () => {
  it('只采用 Core 明确注入的可写路径', () => {
    const workspaceRoot = path.resolve('D:/workspace');
    const explicitCache = path.resolve('D:/ema-cache');
    const result = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [workspaceRoot, explicitCache, explicitCache],
      protectedPaths: [],
      networkAccess: 'none',
    });

    expect(result.config.filesystem.allowWrite).toEqual([
      workspaceRoot,
      explicitCache,
    ]);
  });

  it('同时禁止读取和修改 Core 传入的每一个路径', () => {
    const profileDir = path.resolve('D:/ema-profile');
    const dataDb = path.resolve('E:/ema-data/data.db');
    const workspaceRoot = path.resolve('D:/workspace');
    const result = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [workspaceRoot],
      protectedPaths: [profileDir, dataDb, `${dataDb}-wal`, `${dataDb}-shm`, dataDb],
      networkAccess: 'none',
    });

    expect(result.config.filesystem.denyRead).toEqual([
      profileDir,
      dataDb,
      `${dataDb}-wal`,
      `${dataDb}-shm`,
    ]);
    expect(result.config.filesystem.denyWrite).toEqual(expect.arrayContaining([
      profileDir,
      dataDb,
      `${dataDb}-wal`,
      `${dataDb}-shm`,
    ]));
  });

  it('没有收到私有路径时不会猜测用户主目录中的旧 settings.json', () => {
    const workspaceRoot = path.resolve('D:/workspace');
    const result = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [],
      protectedPaths: [],
      networkAccess: 'none',
    });

    expect(result.config.filesystem.denyRead).toEqual([]);
    expect(result.config.filesystem.denyWrite).toEqual([]);
  });

  it('网络只保留 none 和 full 两档，不再生成域名白名单', () => {
    const workspaceRoot = path.resolve('D:/workspace');
    const denied = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [],
      protectedPaths: [],
      networkAccess: 'none',
    });
    const full = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [],
      protectedPaths: [],
      networkAccess: 'full',
    });

    expect(denied.config.network).toEqual({ access: 'none' });
    expect(full.config.network).toEqual({ access: 'full' });
  });
});
