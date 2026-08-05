// 工作目录解析与 bare-repo 防御测试: cwd 不能越界, 清理只打真实攻击落点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveCommandCwd } from '../resolveCommandCwd.js';
import { CommandRunner } from '../commandRunner.js';
import type { SandboxCapability } from '../types.js';

function makeCapability(workspaceRoot: string, writablePaths: string[] = []): SandboxCapability {
  return {
    workspaceRoot,
    writablePaths: [workspaceRoot, ...writablePaths],
    forbiddenPaths: [],
    networkAccess: 'none',
  };
}

/** cleanup 是内部方法(不上公共 Port),测试经显式收窄访问。 */
function cleanupOf(runner: CommandRunner): void {
  (runner as unknown as { cleanup(): void }).cleanup();
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ema-sandbox-cwd-'));
}

describe('resolveCommandCwd', () => {
  it('省略时使用 workspaceRoot', () => {
    const root = makeWorkspace();
    expect(resolveCommandCwd(undefined, makeCapability(root))).toBe(fs.realpathSync.native(root));
  });

  it('workspaceRoot 内的子目录与 writablePaths 放行', () => {
    const root = makeWorkspace();
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    expect(resolveCommandCwd(sub, makeCapability(root))).toBe(fs.realpathSync.native(sub));

    const cache = makeWorkspace();
    expect(resolveCommandCwd(cache, makeCapability(root, [cache]))).toBe(
      fs.realpathSync.native(cache),
    );
  });

  it('相对路径以 workspaceRoot 为基准解析, 不借宿主进程 cwd', () => {
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

describe('CommandRunner.cleanup — bare-repo 防御(永不删除)', () => {
  function plantBareRepo(root: string, withExploit = true): void {
    fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(root, 'objects'));
    fs.mkdirSync(path.join(root, 'refs'));
    if (withExploit) {
      fs.mkdirSync(path.join(root, 'hooks'));
      fs.writeFileSync(path.join(root, 'hooks', 'pre-commit'), '#!/bin/sh\necho pwned\n');
      fs.writeFileSync(path.join(root, 'config'), '[core]\nrepositoryformatversion = 0\n');
    }
  }

  it('构造后长出的完整 bare 签名: 只警告, 不删任何路径', () => {
    const root = makeWorkspace();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = new CommandRunner(makeCapability(root));
      plantBareRepo(root);

      cleanupOf(runner);

      // 不删除: git init 与 bare 攻击形态相同, 删除可能误伤用户数据(P1)
      expect(fs.existsSync(path.join(root, 'hooks', 'pre-commit'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'config'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'HEAD'))).toBe(true);
      // 但必须有响亮警告, 提示人工确认来源
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bare-repo'));
    } finally {
      warn.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('业务原有 config/hooks + 后续 bare 初始化: 原有数据绝不删除', () => {
    const root = makeWorkspace();
    const runner = new CommandRunner(makeCapability(root));
    // 用户业务文件先于 bare 签名存在
    fs.writeFileSync(path.join(root, 'config'), '{"name":"my-project"}');
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.writeFileSync(path.join(root, 'hooks', 'pre-commit'), '#!/bin/sh\necho legit\n');
    // 之后执行了 git init --bare .(或攻击)长出签名
    fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(root, 'objects'));
    fs.mkdirSync(path.join(root, 'refs'));

    cleanupOf(runner);

    expect(fs.existsSync(path.join(root, 'config'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'hooks', 'pre-commit'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('构造时已是 bare repo 的工作区不警告不触碰', () => {
    const root = makeWorkspace();
    plantBareRepo(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = new CommandRunner(makeCapability(root));

      cleanupOf(runner);

      expect(fs.existsSync(path.join(root, 'hooks', 'pre-commit'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'config'))).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('bare-repo'));
    } finally {
      warn.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
