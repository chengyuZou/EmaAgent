// 测试平台 -> 沙箱后端的纯映射逻辑，覆盖所有平台分支与降级原因。

import { describe, expect, it } from 'vitest';
import { selectBackendForPlatform } from '../detectBackend.js';

describe('selectBackendForPlatform', () => {
  it('macos 直接选 sandbox-exec', () => {
    expect(selectBackendForPlatform('macos')).toEqual({ kind: 'sandbox-exec' });
  });

  it('原生 Linux 走直接 bwrap 探测，失败时给出安装提示', () => {
    const result = selectBackendForPlatform('linux');
    expect(result.kind).toBe('bwrap-direct');
    if (result.kind === 'bwrap-direct') {
      expect(result.degradeReason).toContain('bubblewrap');
    }
  });

  it('WSL2 与原生 Linux 同样走直接 bwrap 探测', () => {
    expect(selectBackendForPlatform('wsl2').kind).toBe('bwrap-direct');
  });

  it('WSL1 无 namespace，直接降级 unisolated 并提示升级', () => {
    const result = selectBackendForPlatform('wsl1');
    expect(result.kind).toBe('unisolated');
    if (result.kind === 'unisolated') {
      expect(result.degradeReason).toContain('WSL1');
      expect(result.degradeReason).toContain('WSL2');
    }
  });

  it('Windows 走 WSL 间接探测路径', () => {
    const result = selectBackendForPlatform('windows');
    expect(result.kind).toBe('bwrap-via-wsl');
    if (result.kind === 'bwrap-via-wsl') {
      expect(result.degradeReason).toContain('bubblewrap');
    }
  });

  it('每个平台分支都返回非空 degradeReason（除 sandbox-exec 外）', () => {
    // 穷举 SandboxPlatform 联合，确保降级路径都有原因可展示给用户。
    const platforms = ['macos', 'linux', 'wsl2', 'wsl1', 'windows'] as const;
    for (const p of platforms) {
      const result = selectBackendForPlatform(p);
      if (result.kind !== 'sandbox-exec') {
        expect(result.degradeReason.length).toBeGreaterThan(0);
      }
    }
  });
});
