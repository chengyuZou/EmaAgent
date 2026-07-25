// 工作目录解析与 bare-repo 防御测试: cwd 不能越界, 清理只打真实攻击落点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommandCwd } from '../resolveCommandCwd.js';
import { CommandRunner } from '../commandRunner.js';
import type { SandboxCapability } from '../types.js';

function makeCapability(workspaceRoot: string, writablePaths: string[] = []): SandboxCapability {
  return {
    workspaceRoot,
    writablePaths: [workspaceRoot, ...writablePaths],
    protectedPaths: [],
    networkAccess: 'none',
  };
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

describe('CommandRunner.cleanup — bare-repo 精确防御', () => {
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

  it('构造后长出的完整 bare 签名: 只拆 hooks/config, 不删仓库本体', () => {
    const root = makeWorkspace();
    const runner = new CommandRunner(makeCapability(root));
    plantBareRepo(root);

    runner.cleanup();

    expect(fs.existsSync(path.join(root, 'hooks'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'config'))).toBe(false);
    // 修复前会连 HEAD/objects/refs 一起误删, 现在保留
    expect(fs.existsSync(path.join(root, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'objects'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'refs'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('普通项目的 config 文件与 hooks 目录(无 bare 签名)不被误伤', () => {
    const root = makeWorkspace();
    const runner = new CommandRunner(makeCapability(root));
    fs.writeFileSync(path.join(root, 'config'), '{"name":"my-project"}');
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.writeFileSync(path.join(root, 'hooks', 'pre-commit'), '#!/bin/sh\necho legit\n');

    runner.cleanup();

    expect(fs.existsSync(path.join(root, 'config'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'hooks', 'pre-commit'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('构造时已是 bare repo 的工作区不被触碰', () => {
    const root = makeWorkspace();
    plantBareRepo(root);
    const runner = new CommandRunner(makeCapability(root));

    runner.cleanup();

    expect(fs.existsSync(path.join(root, 'hooks', 'pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'config'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
