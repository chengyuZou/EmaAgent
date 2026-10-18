import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommandCwd } from '../command/commandPaths.js';
import type { SandboxCapability } from '../types.js';

function makeCapability(cwd: string, writablePaths: string[] = []): SandboxCapability {
  return {
    cwd,
    writablePaths: [cwd, ...writablePaths],
    forbiddenPaths: [],
    networkAccess: 'none',
  };
}


function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-cwd-'));
}

describe('resolveCommandCwd', () => {
  it('省略时使用 cwd', () => {
    const root = makeWorkspace();
    expect(resolveCommandCwd(undefined, makeCapability(root))).toBe(fs.realpathSync.native(root));
  });

  it('cwd 内的子目录与 writablePaths 放行', () => {
    const root = makeWorkspace();
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    expect(resolveCommandCwd(sub, makeCapability(root))).toBe(fs.realpathSync.native(sub));

    const cache = makeWorkspace();
    expect(resolveCommandCwd(cache, makeCapability(root, [cache]))).toBe(
      fs.realpathSync.native(cache),
    );
  });

  it('旧 cwd 被项目移除后仍可作为起点，但不再授权其子目录', () => {
    const oldCwd = makeWorkspace();
    const currentFolder = makeWorkspace();
    const oldSubdirectory = path.join(oldCwd, 'sub');
    fs.mkdirSync(oldSubdirectory);
    const capability: SandboxCapability = {
      cwd: oldCwd,
      writablePaths: [currentFolder],
      forbiddenPaths: [],
      networkAccess: 'none',
    };

    expect(resolveCommandCwd(undefined, capability)).toBe(fs.realpathSync.native(oldCwd));
    expect(resolveCommandCwd('.', capability)).toBe(fs.realpathSync.native(oldCwd));
    expect(resolveCommandCwd(oldCwd, capability)).toBe(fs.realpathSync.native(oldCwd));
    expect(resolveCommandCwd(currentFolder, capability)).toBe(fs.realpathSync.native(currentFolder));
    expect(() => resolveCommandCwd(oldSubdirectory, capability)).toThrow('越出 Sandbox 能力范围');
  });

  it('相对路径以 cwd 为基准解析, 不借宿主进程 cwd', () => {
    const root = makeWorkspace();
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    expect(resolveCommandCwd('sub', makeCapability(root))).toBe(fs.realpathSync.native(sub));
    expect(resolveCommandCwd('.', makeCapability(root))).toBe(fs.realpathSync.native(root));
    // 相对路径越界( ../ )同样拒绝
    expect(() => resolveCommandCwd('..', makeCapability(root))).toThrow('越出 Sandbox 能力范围');
  });

  it('越出能力范围直接拒绝', () => {
    const root = makeWorkspace();
    expect(() => resolveCommandCwd(os.tmpdir(), makeCapability(root))).toThrow('越出 Sandbox 能力范围');
    expect(() => resolveCommandCwd(path.join(root, '..', 'escape'), makeCapability(root))).toThrow();
  });

  it('符号链接/junction 逃逸按真实路径拒绝', () => {
    const root = makeWorkspace();
    const outside = makeWorkspace();
    const link = path.join(root, 'link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveCommandCwd(link, makeCapability(root))).toThrow('越出 Sandbox 能力范围');
  });
});
