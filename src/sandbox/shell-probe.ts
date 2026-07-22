import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getPlatform } from './platform.js';
import { WSL_BASH_SENTINEL } from './types.js';

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

/** Read Git install path from registry (HKLM or HKCU). Returns bash.exe path or null. */
function gitBashFromRegistry(): string | null {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const r = spawnSync(
        'reg', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'],
        { encoding: 'utf8', timeout: 3_000, windowsHide: true },
      );
      if (r.status === 0) {
        const m = r.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (m) {
          const candidate = `${m[1]!.trim()}\\usr\\bin\\bash.exe`;
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Verify that WSL has a usable bash — i.e. a distro is installed and `bash`
 * runs inside it. `wsl --status` returning 0 only means wsl.exe is present
 * (could be no distro), so we actually invoke bash. Returns true iff the
 * probe exits 0 within the timeout.
 */
function probeWslBash(): boolean {
  const r = spawnSync('wsl.exe', ['bash', '-c', 'echo ok'], {
    encoding:    'utf8',
    timeout:     8_000,
    windowsHide: true,
  });
  return r.status === 0;
}

let cached: ShellProbeResult | undefined;

/**
 * Detect bash availability on the current platform.
 * On Linux / macOS: always `{ available: true, path: '/bin/bash' }`.
 * On Windows: checks PATH via `where bash`; returns install options if missing.
 * Result is cached for the process lifetime. Pass `{ fresh: true }` to bypass.
 */
export function probeShell(opts?: { fresh?: boolean }): ShellProbeResult {
  if (!opts?.fresh && cached !== undefined) return cached;

  const platform = getPlatform();
  if (platform !== 'windows') {
    return (cached = { available: true, path: '/bin/bash' });
  }

  const whereResult = spawnSync('where', ['bash'], {
    encoding:    'utf8',
    timeout:     3_000,
    windowsHide: true,
  });

  if (whereResult.status === 0 && whereResult.stdout.trim()) {
    const firstLine = whereResult.stdout.trim().split(/\r?\n/)[0]!.trim();
    return (cached = { available: true, path: firstLine });
  }

  // `where bash` uses the process-inherited PATH, which won't include a freshly
  // installed Git for Windows until the process restarts. Fall back to a direct
  // file-system check: well-known install locations, then registry lookup.
  const knownPath = GIT_BASH_CANDIDATE_PATHS.find(existsSync) ?? gitBashFromRegistry();
  if (knownPath) {
    return (cached = { available: true, path: knownPath });
  }

  // No native bash.exe — but WSL2 with a distro installed gives a usable bash.
  // `wsl --status` returning 0 only proves wsl.exe exists (not that a distro is
  // installed), so actually invoke bash inside WSL to verify. Backends route
  // commands through `wsl.exe bash -c …` when they see the sentinel.
  if (probeWslBash()) {
    return (cached = { available: true, path: WSL_BASH_SENTINEL });
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

  return (cached = {
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
        // winget succeeded — try to find the new bash via known paths + registry.
        // The parent Node process's PATH won't include the new install yet,
        // so `where bash` via spawnSync would still fail. Direct file check works.
        const found = GIT_BASH_CANDIDATE_PATHS.find(existsSync) ?? gitBashFromRegistry();
        cached = found
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
