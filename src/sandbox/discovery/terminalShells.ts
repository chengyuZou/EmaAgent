import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPlatform } from './platform.js';
import { probeBash, runCapture } from './bashProbe.js';

export type TerminalShellKind =
  | 'powershell'
  | 'cmd'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'wsl'
  | 'sh';

export interface TerminalShellInfo {
  readonly kind: TerminalShellKind;
  readonly label: string;
  readonly path: string;
}

// 依次查找各 Shell 的所有 PATH 结果, 最后按种类优先级排序.
const WINDOWS_PROBE_NAMES = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'bash.exe', 'wsl.exe'] as const;
const POSIX_PROBE_NAMES = ['bash', 'zsh', 'fish', 'sh'] as const;
const PROBE_TIMEOUT_MS = 3_000;

export async function detectTerminalShells(): Promise<readonly TerminalShellInfo[]> {
  const paths = getPlatform() === 'windows'
    ? await discoverWindowsShellPaths()
    : await discoverPosixShellPaths();
  return dedupePaths(paths)
    .filter(candidate => existsSync(candidate))
    .map(toShellInfo)
    .sort((a, b) => shellPriority(a.kind) - shellPriority(b.kind));
}

async function discoverWindowsShellPaths(): Promise<string[]> {
  const found: string[] = [];
  for (const name of WINDOWS_PROBE_NAMES) {
    const result = await runCapture('where', [name], PROBE_TIMEOUT_MS);
    if (result.status !== 0) continue;
    found.push(...splitLines(result.stdout));
  }
  // where 找不到 bash 时走 bashProbe 的完整兜底链(git 反推/注册表/WSL);
  // WSL 分支无独立 path(wsl.exe 已由上面的逐名扫描覆盖),只收带 path 的分支.
  if (!found.some(candidate => terminalShellKind(candidate) === 'bash')) {
    const probe = await probeBash();
    if (probe.available && 'path' in probe && probe.path) found.push(probe.path);
  }
  const comspec = process.env.COMSPEC;
  if (comspec?.trim()) found.push(comspec.trim());
  return found;
}

async function discoverPosixShellPaths(): Promise<string[]> {
  const found: string[] = [];
  const loginShell = process.env.SHELL;
  if (loginShell?.trim()) found.push(loginShell.trim());
  for (const name of POSIX_PROBE_NAMES) {
    const result = await runCapture('which', ['-a', name], PROBE_TIMEOUT_MS);
    if (result.status !== 0) continue;
    found.push(...splitLines(result.stdout));
  }
  return found;
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// Windows 文件系统大小写不敏感,按小写归一去重;POSIX 按原样去重.
function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(candidate => {
    const identity = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function terminalShellKind(shellPath: string): TerminalShellKind {
  const name = path.basename(shellPath).toLowerCase();
  switch (name) {
    case 'pwsh':
    case 'pwsh.exe':
    case 'powershell':
    case 'powershell.exe':
      return 'powershell';
    case 'cmd':
    case 'cmd.exe':
      return 'cmd';
    case 'bash':
    case 'bash.exe':
      return 'bash';
    case 'zsh':
      return 'zsh';
    case 'fish':
      return 'fish';
    case 'wsl':
    case 'wsl.exe':
      return 'wsl';
    default:
      return 'sh';
  }
}

export function terminalShellLabel(kind: TerminalShellKind, shellPath: string): string {
  const lower = shellPath.toLowerCase();
  switch (kind) {
    case 'powershell':
      return lower.endsWith('pwsh.exe') || lower.endsWith('/pwsh') ? 'PowerShell 7' : 'Windows PowerShell';
    case 'cmd':
      return 'Command Prompt';
    case 'bash':
      return lower.includes('git') ? 'Git Bash' : 'Bash';
    case 'zsh':
      return 'Zsh';
    case 'fish':
      return 'Fish';
    case 'wsl':
      return 'WSL';
    case 'sh':
      return 'Shell';
  }
}

// 第一项用于终端自动选择, 其余项目按此顺序展示.
function shellPriority(kind: TerminalShellKind): number {
  switch (kind) {
    case 'powershell': return 0;
    case 'bash': return 1;
    case 'zsh': return 2;
    case 'fish': return 3;
    case 'wsl': return 4;
    case 'cmd': return 5;
    case 'sh': return 6;
  }
}

function toShellInfo(shellPath: string): TerminalShellInfo {
  const kind = terminalShellKind(shellPath);
  return { kind, label: terminalShellLabel(kind, shellPath), path: shellPath };
}
