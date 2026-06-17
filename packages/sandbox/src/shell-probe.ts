import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getPlatform } from './platform.js';

export type ShellProbeResult =
  | { available: true;  path: string }
  | { available: false; wingetAvailable: boolean; wslAvailable: boolean };

export interface GitInstallResult {
  ok:  boolean;
  log: string;
}

// Known default bash.exe locations after a standard Git for Windows install.
// Used to re-detect immediately after winget install, before the child-process
// PATH cache (inherited from the parent Node process at startup) is refreshed.
const GIT_BASH_CANDIDATE_PATHS = [
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  `${process.env['LOCALAPPDATA'] ?? 'C:\\Users\\Default\\AppData\\Local'}\\Programs\\Git\\usr\\bin\\bash.exe`,
];

let _cached: ShellProbeResult | undefined;

/**
 * Detect bash availability on the current platform.
 * On Linux / macOS: always `{ available: true, path: '/bin/bash' }`.
 * On Windows: checks PATH via `where bash`; returns install options if missing.
 * Result is cached for the process lifetime. Pass `{ fresh: true }` to bypass.
 */
export function probeShell(opts?: { fresh?: boolean }): ShellProbeResult {
  if (!opts?.fresh && _cached !== undefined) return _cached;

  const platform = getPlatform();
  if (platform !== 'windows') {
    return (_cached = { available: true, path: '/bin/bash' });
  }

  const whereResult = spawnSync('where', ['bash'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  if (whereResult.status === 0 && whereResult.stdout.trim()) {
    const firstLine = whereResult.stdout.trim().split(/\r?\n/)[0]!.trim();
    return (_cached = { available: true, path: firstLine });
  }

  const wingetResult = spawnSync('winget', ['--version'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  const wslResult = spawnSync('wsl', ['--status'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  return (_cached = {
    available:       false,
    wingetAvailable: wingetResult.status === 0,
    wslAvailable:    wslResult.status === 0,
  });
}

/**
 * Install Git for Windows via winget (silent, no UAC required for per-user scope).
 * On success, invalidates the probe cache so the next `probeShell()` re-detects.
 * May take 1-3 minutes depending on download speed.
 */
export function installGitViaWinget(): Promise<GitInstallResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      'winget',
      [
        'install', '--id', 'Git.Git',
        '-e', '--source', 'winget',
        '--scope', 'user',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ],
      { windowsHide: true },
    );

    const chunks: string[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, log: '安装超时（5 分钟），请手动下载安装。' });
    }, 300_000);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const ok = code === 0;
      if (ok) {
        // winget succeeded — try to find the new bash via known paths first.
        // The parent Node process's PATH won't include the new install yet,
        // so `where bash` via spawnSync would still fail. Direct file check works.
        const found = GIT_BASH_CANDIDATE_PATHS.find(existsSync);
        _cached = found
          ? { available: true, path: found }
          : undefined; // fall back to re-probe on next probeShell() call
      }
      resolve({ ok, log: chunks.join('').trim() });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, log: err.message });
    });
  });
}
