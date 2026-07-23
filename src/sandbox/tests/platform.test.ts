// 测试 Linux 内核 release 字符串的平台分类逻辑，覆盖原生 Linux、WSL1、WSL2 与大小写。

import { describe, expect, it } from 'vitest';
import { classifyLinuxRelease } from '../platform.js';

describe('classifyLinuxRelease', () => {
  it('原生 Linux release 不含 microsoft，归为 linux', () => {
    expect(classifyLinuxRelease('5.15.0-91-generic')).toBe('linux');
    expect(classifyLinuxRelease('6.1.0-1014-aws')).toBe('linux');
  });

  it('WSL2 release 含 microsoft + wsl2，归为 wsl2', () => {
    // 实际 WSL2 release 形如 5.15.153.1-microsoft-standard-WSL2
    expect(classifyLinuxRelease('5.15.153.1-microsoft-standard-WSL2')).toBe('wsl2');
  });

  it('WSL1 release 含 microsoft 但不含 wsl2，归为 wsl1', () => {
    // 实际 WSL1 release 形如 4.4.0-17763-Microsoft
    expect(classifyLinuxRelease('4.4.0-17763-Microsoft')).toBe('wsl1');
  });

  it('大小写不敏感：大写 MICROSOFT + WSL2 仍判 wsl2', () => {
    expect(classifyLinuxRelease('5.15-MICROSOFT- STANDARD - WSL2')).toBe('wsl2');
  });

  it('大小写不敏感：大写 MICROSOFT 无 wsl2 判 wsl1', () => {
    expect(classifyLinuxRelease('4.4.0-MICROSOFT')).toBe('wsl1');
  });

  it('空字符串归为 linux', () => {
    expect(classifyLinuxRelease('')).toBe('linux');
  });
});
