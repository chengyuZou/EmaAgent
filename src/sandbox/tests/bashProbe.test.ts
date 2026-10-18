// 这些测试仅在 Windows 运行, 因为其他平台不使用 where, 注册表和 WSL 回退链.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatform } from '../discovery/platform.js';
import { probeBash, resetBashProbeCache } from '../discovery/bashProbe.js';

interface Behavior {
  code: number | null;
  stdout?: string;
}

const state = vi.hoisted(() => ({
  behaviors: [] as Array<{ match: (exe: string, args: string[]) => boolean; behavior: Behavior }>,
  calls: [] as Array<{ exe: string; args: string[] }>,
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: (exe: string, args: string[]) => {
      state.calls.push({ exe, args: [...args] });
      const found = state.behaviors.find((b) => b.match(exe, args));
      const behavior: Behavior = found?.behavior ?? { code: 1 };
      const proc = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        stdout: InstanceType<typeof EventEmitter>;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.kill = () => undefined;
      setImmediate(() => {
        if (behavior.stdout) proc.stdout.emit('data', Buffer.from(behavior.stdout));
        proc.emit('close', behavior.code);
      });
      return proc;
    },
  };
});

const onWindows = getPlatform() === 'windows';

function called(exe: string, ...argsPrefix: string[]): boolean {
  return state.calls.some((c) =>
    c.exe === exe && argsPrefix.every((a, i) => c.args[i] === a));
}

/** 造一个 <root>/cmd/git.exe + <root>/usr/bin/bash.exe 的 Git 安装目录夹具. */
function makeGitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-bashprobe-'));
  fs.mkdirSync(path.join(root, 'cmd'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cmd', 'git.exe'), '');
  fs.writeFileSync(path.join(root, 'usr', 'bin', 'bash.exe'), '');
  return root;
}

describe.skipIf(!onWindows)('probeBash Windows 回退链', () => {
  beforeEach(() => {
    state.behaviors.length = 0;
    state.calls.length = 0;
    resetBashProbeCache();
  });

  it('PATH 命中即短路, 不再探 git/注册表/WSL', async () => {
    state.behaviors.push({
      match: (exe, args) => exe === 'where' && args[0] === 'bash',
      behavior: { code: 0, stdout: 'C:\\Git\\usr\\bin\\bash.exe\r\n' },
    });

    const result = await probeBash();

    expect(result).toEqual({
      available: true, source: 'native', path: 'C:\\Git\\usr\\bin\\bash.exe',
    });
    expect(called('where', 'git')).toBe(false);
    expect(called('reg')).toBe(false);
    expect(called('wsl.exe')).toBe(false);
    await expect(probeBash()).resolves.toEqual(result);
  });

  it('PATH 失败时从 where git 反推同安装根的 bash.exe', async () => {
    const gitRoot = makeGitRoot();
    state.behaviors.push({
      match: (exe, args) => exe === 'where' && args[0] === 'git',
      behavior: { code: 0, stdout: `${path.join(gitRoot, 'cmd', 'git.exe')}\r\n` },
    });

    const result = await probeBash();

    expect(result).toEqual({
      available: true, source: 'native', path: path.join(gitRoot, 'usr', 'bin', 'bash.exe'),
    });
    expect(called('reg')).toBe(false);
    fs.rmSync(gitRoot, { recursive: true, force: true });
  });

  it('git 反推失败时读注册表 InstallPath', async () => {
    const gitRoot = makeGitRoot();
    state.behaviors.push({
      match: (exe, args) => exe === 'reg' && args.includes('HKLM\\SOFTWARE\\GitForWindows'),
      behavior: { code: 0, stdout: `    InstallPath    REG_SZ    ${gitRoot}\r\n` },
    });

    const result = await probeBash();

    expect(result).toEqual({
      available: true, source: 'native', path: `${gitRoot}\\usr\\bin\\bash.exe`,
    });
    expect(called('wsl.exe')).toBe(false);
    fs.rmSync(gitRoot, { recursive: true, force: true });
  });

  it('本机全无 bash 时 WSL 可用则报 source:wsl(无路径)', async () => {
    state.behaviors.push({
      match: (exe, args) => exe === 'wsl.exe' && args[0] === 'bash',
      behavior: { code: 0, stdout: 'ok\n' },
    });

    const result = await probeBash();

    expect(result).toEqual({ available: true, source: 'wsl' });
    expect('path' in result).toBe(false);
  });

  it('全部失败时只报告 Bash 不可用, 不额外检测安装工具', async () => {
    const result = await probeBash();

    expect(result).toEqual({ available: false });
    expect(called('wsl.exe', 'bash')).toBe(true);
    expect(called('winget')).toBe(false);
    expect(called('wsl', '--status')).toBe(false);
  });

  it('fresh 重新探测, 后续调用共用新的结果', async () => {
    state.behaviors.push({
      match: (exe, args) => exe === 'where' && args[0] === 'bash',
      behavior: { code: 0, stdout: 'C:\\Git\\usr\\bin\\bash.exe\r\n' },
    });
    expect((await probeBash()).available).toBe(true);

    state.behaviors.length = 0;
    state.behaviors.push({ match: () => true, behavior: { code: 1 } });
    const pending = probeBash({ fresh: true });
    expect(probeBash()).toBe(pending);
    expect((await pending).available).toBe(false);
  });
});
