// 终端 Shell 探测的纯函数测试:kind 判别、标签文案与旧 Rust 实现的平移对拍。
import { describe, expect, it } from 'vitest';
import { detectTerminalShells, terminalShellKind, terminalShellLabel } from '../terminalShells.js';

describe('terminalShellKind', () => {
  it('按可执行文件名判别,与旧 Rust shell_kind 一致', () => {
    expect(terminalShellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(terminalShellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell');
    expect(terminalShellKind('/usr/bin/pwsh')).toBe('powershell');
    expect(terminalShellKind('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(terminalShellKind('D:\\Git\\bin\\bash.exe')).toBe('bash');
    expect(terminalShellKind('/bin/bash')).toBe('bash');
    expect(terminalShellKind('/usr/bin/zsh')).toBe('zsh');
    expect(terminalShellKind('/usr/local/bin/fish')).toBe('fish');
    expect(terminalShellKind('C:\\Windows\\System32\\wsl.exe')).toBe('wsl');
    expect(terminalShellKind('/bin/dash')).toBe('sh');
  });
});

describe('terminalShellLabel', () => {
  it('pwsh 显示 PowerShell 7,其余 PowerShell 显示 Windows PowerShell', () => {
    expect(terminalShellLabel('powershell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('PowerShell 7');
    expect(terminalShellLabel('powershell', '/usr/bin/pwsh')).toBe('PowerShell 7');
    expect(terminalShellLabel('powershell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('Windows PowerShell');
  });

  it('路径含 git 的 bash 显示 Git Bash', () => {
    expect(terminalShellLabel('bash', 'D:\\Git\\bin\\bash.exe')).toBe('Git Bash');
    expect(terminalShellLabel('bash', '/bin/bash')).toBe('Bash');
  });

  it('其余 kind 使用固定文案', () => {
    expect(terminalShellLabel('cmd', 'C:\\Windows\\System32\\cmd.exe')).toBe('Command Prompt');
    expect(terminalShellLabel('zsh', '/usr/bin/zsh')).toBe('Zsh');
    expect(terminalShellLabel('fish', '/usr/bin/fish')).toBe('Fish');
    expect(terminalShellLabel('wsl', 'C:\\Windows\\System32\\wsl.exe')).toBe('WSL');
    expect(terminalShellLabel('sh', '/bin/sh')).toBe('Shell');
  });
});

describe('detectTerminalShells', () => {
  it('真实机器上返回按优先级排序的列表,首条即自动选择落点', async () => {
    const shells = await detectTerminalShells();
    expect(Array.isArray(shells)).toBe(true);
    for (const shell of shells) {
      expect(shell.path.length).toBeGreaterThan(0);
      expect(shell.label.length).toBeGreaterThan(0);
    }
    const priorities = shells.map(shell => shell.kind);
    expect(priorities).toEqual([...priorities].sort((a, b) => priorityOf(a) - priorityOf(b)));
  });
});

function priorityOf(kind: string): number {
  const order = ['powershell', 'bash', 'zsh', 'fish', 'wsl', 'cmd', 'sh'];
  return order.indexOf(kind);
}
