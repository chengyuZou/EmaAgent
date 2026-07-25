// 这里规范化并解析工具路径，拦截跨平台危险路径、设备名和 symlink 越界。
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { getPlatform } from './platformPaths.js';

// ── Case normalization ────────────────────────────────────────────────────────

/**
 * 规范化路径用于比较:windows/macOS 文件系统大小写不敏感,统一转小写;
 * Linux/WSL 原生文件系统大小写敏感,保留原样,避免 /Home 与 /home 被误判为同一目录。
 */
export function normalizeCaseForComparison(p: string): string {
  const platform = getPlatform();
  return (platform === 'windows' || platform === 'macos') ? p.toLowerCase() : p;
}

// ── macOS symlink aliases ─────────────────────────────────────────────────────

/**
 * On macOS /tmp → /private/tmp and /var → /private/var are common symlinks.
 * realpathSync resolves them, which causes mismatches when comparing against
 * paths constructed from the non-private prefix. Normalise both directions.
 */
export function normalizeMacOsSymlinks(p: string): string {
  return p
    .replace(/^\/private\/var(\/|$)/, '/var$1')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1');
}

// ── Symlink-aware path resolution ─────────────────────────────────────────────

/**
 * Returns the original path PLUS its symlink-resolved form (if different).
 * Both must pass all permission checks to prevent symlink escape attacks like:
 *   ln -s /etc/passwd /workspace/.env
 *
 * Non-existent paths (e.g. files about to be created) just return [rawPath].
 */
export function getPathsForPermissionCheck(rawPath: string): string[] {
  const expanded = rawPath.startsWith('~')
    ? path.join(os.homedir(), rawPath.slice(1))
    : rawPath;

  const absolute = path.resolve(expanded);
  const paths = new Set<string>([absolute]);

  try {
    const resolved = resolveExistingPathOrAncestor(absolute);
    paths.add(resolved);
    // Apply macOS alias normalisation to the resolved form as well
    if (getPlatform() === 'macos') {
      paths.add(normalizeMacOsSymlinks(resolved));
    }
  } catch {
    // 卷不可用或祖先不可访问时保留 absolute；后续仍不会获得额外放行。
  }

  return [...paths];
}

/** 新文件自身不存在时，解析最近存在的父目录，防止通过父目录 symlink 越出 workspace。 */
function resolveExistingPathOrAncestor(absolutePath: string): string {
  let cursor = absolutePath;
  const missingSegments: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`找不到可解析的路径祖先：${absolutePath}`);
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  return path.join(fs.realpathSync(cursor), ...missingSegments);
}

// ── Dangerous file / directory constants ──────────────────────────────────────

export const DANGEROUS_FILES: ReadonlySet<string> = new Set([
  '.gitconfig', '.gitcredentials', '.git-credentials',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
  '.env', '.env.local', '.env.production', '.env.development',
  '.mcp.json', '.ema-agent/settings.json',
  // Unix shell configs — relevant on Windows too via WSL / Git Bash
  '.bashrc', '.bash_profile', '.bash_logout',
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  '.profile', '.tcshrc', '.cshrc', '.kshrc',
  // SSH credentials
  '.ssh/config', '.ssh/authorized_keys', '.ssh/known_hosts',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);

export const DANGEROUS_DIRS: ReadonlySet<string> = new Set([
  '.git', '.ssh', '.gnupg', '.gpg',
  '.aws', '.azure', '.kube',
  '.ema-agent', 'node_modules',
  '__pycache__', '.venv', 'venv',
]);

// ── Common safety checks (all platforms) ─────────────────────────────────────

function checkCommonSafety(p: string): string | undefined {
  if (p.includes('\0')) return 'path contains a null byte';
  if (/\$\{?[A-Za-z_]/.test(p) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(p))
    return 'path contains shell variable expansion';
  if (p.includes('=~')) return 'path contains shell expansion operator';
  if (/[*?[\]{},!]/.test(p)) return 'path contains glob metacharacters';
  return undefined;
}

// ── Windows / WSL-specific checks ────────────────────────────────────────────

const DOS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
]);

/**
 * Detects Windows / NTFS path attacks.
 * Runs on 'windows' AND 'wsl' — DrvFs mounts on WSL route file operations
 * through the Windows kernel, so ADS colon syntax is still interpreted there.
 *
 * Covers:
 *   NTFS Alternate Data Streams  (file.txt:stream — Windows/WSL only)
 *   Long-path / device prefixes  (\\?\ or \\.\  or //?/ or //./  )
 *   Trailing dots or spaces      (bypass extension checks)
 *   8.3 short names              (PROGRA~1)
 *   DOS device names             (.git.CON)
 *   Three-or-more consecutive dots as a path component
 *   UNC paths (defense-in-depth on all platforms)
 */
export function hasSuspiciousWindowsPath(p: string): boolean {
  const platform = getPlatform();

  // ADS colon — Windows kernel only (Windows + WSL DrvFs)
  if (platform === 'windows' || platform === 'wsl') {
    if (p.indexOf(':', 2) !== -1) return true;
  }

  // Long-path / device prefixes (both slash variants)
  if (
    p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\') ||
    p.startsWith('//?/')    || p.startsWith('//./')
  ) return true;

  // UNC paths (all platforms, defense-in-depth)
  if ((p.startsWith('\\\\') || p.startsWith('//')) && p.length > 2) return true;

  // Trailing dot or whitespace (Windows strips these during resolution)
  if (/[.\s]+$/.test(p)) return true;

  // 8.3 tilde short-name heuristic
  if (/~\d/.test(p)) return true;

  // Three-or-more consecutive dots as a path component
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(p)) return true;

  // DOS device name as file extension suffix (e.g. .git.CON)
  if (/\.(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(p)) return true;

  // DOS device name as a path segment
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of segments) {
    const base = (seg.split('.')[0] ?? seg).toUpperCase();
    if (DOS_DEVICE_NAMES.has(base)) return true;
  }

  return false;
}

// ── Unix-specific checks ──────────────────────────────────────────────────────

const DANGEROUS_UNIX_PREFIXES: readonly string[] = [
  '/proc/self/mem', '/proc/self/maps', '/proc/kcore',
  '/dev/mem', '/dev/kmem', '/dev/port',
];

function checkUnixSafety(p: string): string | undefined {
  const normalised = p.replace(/\\/g, '/');
  for (const prefix of DANGEROUS_UNIX_PREFIXES) {
    if (normalised === prefix || normalised.startsWith(prefix + '/')) {
      return `access to "${prefix}" is forbidden`;
    }
  }
  return undefined;
}

// ── Dangerous name check (all platforms) ─────────────────────────────────────

/**
 * Returns a human-readable reason if the path targets a dangerous file or
 * directory by name, or undefined if the name is safe.
 * Uses case-insensitive comparison to prevent mixed-case bypasses.
 */
export function getDangerousPathReason(rawPath: string): string | undefined {
  const normalised = normalizeCaseForComparison(rawPath.replace(/\\/g, '/'));
  const segments   = normalised.split('/').filter(Boolean);
  const filename   = segments.length > 0 ? segments[segments.length - 1]! : '';

  for (const seg of segments) {
    if (DANGEROUS_DIRS.has(seg)) {
      return `path is inside protected directory "${seg}"`;
    }
  }

  if (DANGEROUS_FILES.has(filename)) {
    return `"${filename}" is a protected system file`;
  }

  const relative = segments.join('/');
  for (const dangerous of DANGEROUS_FILES) {
    if (relative.endsWith(normalizeCaseForComparison(dangerous.replace(/\\/g, '/')))) {
      return `path matches protected file pattern "${dangerous}"`;
    }
  }

  return undefined;
}

// ── Removal safety ────────────────────────────────────────────────────────────

export function isDangerousRemovalPath(rawPath: string): boolean {
  if (rawPath === '*' || rawPath === '/*' || rawPath === '*.*') return true;

  const resolved = path.resolve(rawPath);
  const parts    = resolved.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return true;

  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (home && resolved === path.resolve(home)) return true;

  return false;
}

// ── Shell-expansion helper (exported) ─────────────────────────────────────────

export function hasShellExpansion(p: string): boolean {
  return checkCommonSafety(p) !== undefined;
}

// ── Compound check ────────────────────────────────────────────────────────────

export interface PathSafetyResult {
  safe:    boolean;
  reason?: string;
}

/**
 * Full bypass-immune path safety check.
 * Run this on EVERY resolved path (original + symlink) before any file tool.
 *
 * Order:
 *  1. Common (null bytes, shell expansion, glob injection)
 *  2. Platform-specific (Windows/WSL or Unix virtual filesystems)
 *  Note: dangerous file/dir names are NOT checked here — they live in
 *  getDangerousPathReason() and only block writes (not reads) in the pipeline.
 */
export function checkPathSafety(rawPath: string): PathSafetyResult {
  const common = checkCommonSafety(rawPath);
  if (common) return { safe: false, reason: common };

  const platform = getPlatform();
  if (platform === 'windows' || platform === 'wsl') {
    if (hasSuspiciousWindowsPath(rawPath)) {
      return { safe: false, reason: 'path contains suspicious Windows path pattern (NTFS ADS, device name, short name, or UNC)' };
    }
  } else {
    const unix = checkUnixSafety(rawPath);
    if (unix) return { safe: false, reason: unix };
  }

  return { safe: true };
}
