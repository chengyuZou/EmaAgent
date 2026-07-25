// 后端启动形态测试: macOS 不多加引号; bwrap 直启 argv 不拼串; WSL 路径翻译。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxExecBackend } from '../backends/sandbox-exec.js';
import { buildBubblewrapCommand } from '../backends/bubblewrap.js';
import type { SandboxConfig } from '../types.js';

const config: SandboxConfig = {
  filesystem: {
    allowWrite: ['/home/u/proj'],
    denyWrite:  ['/home/u/proj/.git'],
    denyRead:   ['/home/u/.ema-agent/profile.db'],
  },
  network: { access: 'none' },
};

describe('SandboxExecBackend', () => {
  it('spawn 直传 argv, 命令不再包一层引号', () => {
    const backend = new SandboxExecBackend();
    const wrapped = backend.wrap('ls -la "My Documents"', '/bin/bash', config);

    expect(wrapped.executable).toBe('sandbox-exec');
    expect(wrapped.args[0]).toBe('-p');
    expect(wrapped.args[2]).toBe('/bin/bash');
    expect(wrapped.args[3]).toBe('-c');
    // 关键回归: 原实现把命令包成 '...' 导致 bash -c 收到带引号的"命令名"
    expect(wrapped.args[4]).toBe('ls -la "My Documents"');
  });

  it('profile 拒绝 denyRead 子路径且断网', () => {
    const backend = new SandboxExecBackend();
    const wrapped = backend.wrap('ls', '/bin/bash', config);
    const profile = wrapped.args[1]!;

    expect(profile).toContain('(deny file-read* (subpath "/home/u/.ema-agent/profile.db"))');
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain('(allow file-write* (subpath "/home/u/proj"))');
  });

  it('full 网络模式显式开放(deny default 起手, 不写 allow 等于断网)', () => {
    const backend = new SandboxExecBackend();
    const fullConfig: SandboxConfig = { ...config, network: { access: 'full' } };
    const profile = backend.wrap('ls', '/bin/bash', fullConfig).args[1]!;

    expect(profile).toContain('(allow network-outbound)');
    expect(profile).toContain('(allow network-inbound)');
    expect(profile).not.toContain('(deny network-outbound)');
  });
});

describe('buildBubblewrapCommand', () => {
  it('原生 Linux: 直接 argv 启动 bwrap, 路径不带引号', () => {
    const wrapped = buildBubblewrapCommand('echo "hi there"', '/bin/bash', config, 'linux');

    expect(wrapped.executable).toBe('bwrap');
    expect(wrapped.args).toContain('--unshare-net');
    expect(wrapped.args).toContain('--die-with-parent');
    // denyRead 用 /dev/null 覆盖(path.resolve 结果随宿主平台)
    const nullIdx = wrapped.args.indexOf('/dev/null');
    expect(nullIdx).toBeGreaterThan(-1);
    expect(wrapped.args[nullIdx + 1]).toBe(path.resolve('/home/u/.ema-agent/profile.db'));
    // 直接 argv: 命令与路径都不包引号
    const sep = wrapped.args.indexOf('--');
    expect(wrapped.args.slice(sep + 1)).toEqual(['/bin/bash', '-c', 'echo "hi there"']);
    expect(wrapped.args).toContain(path.resolve('/home/u/proj'));
  });

  it('Windows: 经 wsl.exe 路由并把盘符翻译成 /mnt/<drive>', () => {
    const winConfig: SandboxConfig = {
      filesystem: {
        allowWrite: ['D:\\workspace'],
        denyWrite:  [],
        denyRead:   [],
      },
      network: { access: 'full' },
    };
    const wrapped = buildBubblewrapCommand('echo ok', 'bash', winConfig, 'windows');

    expect(wrapped.executable).toBe('wsl.exe');
    expect(wrapped.args[0]).toBe('bash');
    const line = wrapped.args[2]!;
    expect(line).toContain('bwrap');
    expect(line).toContain('/mnt/d/workspace');
    expect(line).not.toContain('--unshare-net');
  });

  it('WSL: denyRead 目录在翻译前判定, 挂 --tmpfs 而不是 /dev/null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-bwrap-deny-'));
    const file = path.join(dir, 'secret.txt');
    fs.writeFileSync(file, 'x');
    const winConfig: SandboxConfig = {
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [dir, file] },
      network: { access: 'none' },
    };
    const line = buildBubblewrapCommand('echo ok', 'bash', winConfig, 'windows').args[2]!;

    // 目录 → --tmpfs 遮蔽; 文件 → /dev/null 覆盖(翻译前判定, 不受宿主 statSync 失真影响)
    expect(line).toContain('--tmpfs');
    expect(line).toContain('/dev/null');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
