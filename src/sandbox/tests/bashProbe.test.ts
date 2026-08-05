// bashProbe Windows 回退链测试: mock spawn 逐层放行/失败,验证探测顺序、短路与判别联合形状。
// 仅 Windows 可跑(非 Windows 平台探测恒为 native /bin/bash,不经过此链)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatform } from '../detectPlatform.js';
import { probeBash, probeBashSettled, resetBashProbeCache } from '../bashProbe.js';

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
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
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

/** 造一个 <root>/cmd/git.exe + <root>/usr/bin/bash.exe 的 Git 安装目录夹具。 */
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
    expect(probeBashSettled()).toEqual(result);
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

  it('全部失败时并行报告 winget/wsl 可用性', async () => {
    state.behaviors.push(
      { match: (exe) => exe === 'winget', behavior: { code: 0, stdout: 'v1.7' } },
      { match: (exe) => exe === 'wsl', behavior: { code: 1 } },
    );

    const result = await probeBash();

    expect(result).toEqual({ available: false, wingetAvailable: true, wslAvailable: false });
    expect(called('winget', '--version')).toBe(true);
    expect(called('wsl', '--status')).toBe(true);
  });

  it('fresh 强制重探, 且重探途中旧 settled 被清空', async () => {
    state.behaviors.push({
      match: (exe, args) => exe === 'where' && args[0] === 'bash',
      behavior: { code: 0, stdout: 'C:\\Git\\usr\\bin\\bash.exe\r\n' },
    });
    await probeBash();
    expect(probeBashSettled()?.available).toBe(true);

    // 重探未结算期间(mock 经 setImmediate 才回包),peek 必须是 undefined 而不是过期旧值。
    state.behaviors.length = 0;
    state.behaviors.push({ match: () => true, behavior: { code: 1 } });
    const pending = probeBash({ fresh: true });
    expect(probeBashSettled()).toBeUndefined();
    await pending;
    expect(probeBashSettled()?.available).toBe(false);
  });
});
