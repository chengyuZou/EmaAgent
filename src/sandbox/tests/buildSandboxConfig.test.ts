// 这里测试 Sandbox 只保护 LocalHost 传入的真实私有路径，不再自行猜旧设置文件位置。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxConfig } from '../buildSandboxConfig.js';

describe('buildSandboxConfig 私有路径', () => {
  it('只采用 LocalHost 明确注入的可写路径', () => {
    const workspaceRoot = path.resolve('D:/workspace');
    const explicitCache = path.resolve('D:/ema-cache');
    const result = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [workspaceRoot, explicitCache, explicitCache],
      forbiddenPaths: [],
      networkAccess: 'none',
    });

    expect(result.filesystem.allowWrite).toEqual([
      workspaceRoot,
      explicitCache,
    ]);
  });

  it('同时禁止读取和修改 LocalHost 传入的每一个路径', () => {
    const profileDir = path.resolve('D:/ema-profile');
    const dataDb = path.resolve('E:/ema-data/data.db');
    const workspaceRoot = path.resolve('D:/workspace');
    const result = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [workspaceRoot],
      forbiddenPaths: [profileDir, dataDb, `${dataDb}-wal`, `${dataDb}-shm`, dataDb],
      networkAccess: 'none',
    });

    expect(result.filesystem.denyRead).toEqual([
      profileDir,
      dataDb,
      `${dataDb}-wal`,
      `${dataDb}-shm`,
    ]);
    expect(result.filesystem.denyWrite).toEqual(expect.arrayContaining([
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
      forbiddenPaths: [],
      networkAccess: 'none',
    });

    expect(result.filesystem.denyRead).toEqual([]);
    expect(result.filesystem.denyWrite).toEqual([]);
  });

  it('网络只保留 none 和 full 两档，不再生成域名白名单', () => {
    const workspaceRoot = path.resolve('D:/workspace');
    const denied = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [],
      forbiddenPaths: [],
      networkAccess: 'none',
    });
    const full = buildSandboxConfig({
      workspaceRoot,
      writablePaths: [],
      forbiddenPaths: [],
      networkAccess: 'full',
    });

    expect(denied.network).toEqual({ access: 'none' });
    expect(full.network).toEqual({ access: 'full' });
  });

  it('符号链接路径按真实路径落配置, 与 cwd 校验口径一致', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-real-'));
    const link = path.join(os.tmpdir(), `ema-sandbox-link-${process.pid}`);
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = buildSandboxConfig({
        workspaceRoot: real,
        writablePaths: [link],
        forbiddenPaths: [],
        networkAccess: 'none',
      });
      const expectedReal = fs.realpathSync.native(real).replace(/^\\\\\?\\/, '');
      expect(result.filesystem.allowWrite).toEqual([expectedReal]);
      expect(result.filesystem.allowWrite[0]).not.toContain('\\\\?\\');
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
