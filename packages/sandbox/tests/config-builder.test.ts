// 这里测试 Sandbox 只保护 Core 传入的真实私有路径，不再自行猜旧设置文件位置。

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxConfig } from '../src/config-builder.js';

describe('buildSandboxConfig 私有路径', () => {
  it('同时禁止读取和修改 Core 传入的每一个路径', () => {
    const profileDir = path.resolve('D:/ema-profile');
    const dataDb = path.resolve('E:/ema-data/data.db');
    const result = buildSandboxConfig([], {
      workspaceRoot: path.resolve('D:/workspace'),
      protectedPaths: [profileDir, dataDb, `${dataDb}-wal`, `${dataDb}-shm`, dataDb],
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
    const result = buildSandboxConfig([], {
      workspaceRoot: '',
      protectedPaths: [],
    });

    expect(result.config.filesystem.denyRead).toEqual([]);
    expect(result.config.filesystem.denyWrite).toEqual([]);
  });
});
