// 这里测试 Linux、WSL 和 macOS 沙箱是否严格执行 none/full 两档网络策略。

import { describe, expect, it } from 'vitest';
import { BubblewrapBackend } from '../backends/bubblewrap.js';
import { SandboxExecBackend } from '../backends/sandbox-exec.js';
import type { SandboxConfig } from '../types.js';

function config(access: 'none' | 'full'): SandboxConfig {
  return {
    filesystem: {
      allowWrite: [],
      denyWrite: [],
      denyRead: [],
      allowRead: [],
    },
    network: { access },
  };
}

describe('Sandbox V1 网络策略', () => {
  it('Bubblewrap 在 none 时断网，在 full 时不添加断网参数', () => {
    const backend = new BubblewrapBackend();
    const denied = backend.wrap('echo ok', 'bash', config('none')).args.join(' ');
    const full = backend.wrap('echo ok', 'bash', config('full')).args.join(' ');

    expect(denied).toContain('--unshare-net');
    expect(full).not.toContain('--unshare-net');
  });

  it('macOS 在 none 时禁止全部网络，在 full 时不伪造域名规则', () => {
    const backend = new SandboxExecBackend();
    const deniedProfile = backend.wrap('echo ok', '/bin/bash', config('none')).args[1];
    const fullProfile = backend.wrap('echo ok', '/bin/bash', config('full')).args[1];

    expect(deniedProfile).toContain('(deny network-outbound)');
    expect(deniedProfile).toContain('(deny network-inbound)');
    expect(deniedProfile).not.toContain('localhost');
    expect(fullProfile).not.toContain('network-outbound');
    expect(fullProfile).not.toContain('remote tcp');
  });
});
