// 工具传入的是不可信的原始路径字符串 而权限检查需要在一个规范化、真实、无歧义的路径上做判断

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { getPlatform } from './platformPaths.js';

// ── 大小写规范化 ──────────────────────────────────────────────────────────────

/**
 * 规范化路径用于比较:windows/macOS 文件系统大小写不敏感,统一转小写;
 * Linux/WSL 原生文件系统大小写敏感,保留原样,避免 /Home 与 /home 被误判为同一目录。
 */
export function normalizeCaseForComparison(p: string): string {
  const platform = getPlatform();
  return (platform === 'windows' || platform === 'macos') ? p.toLowerCase() : p;
}

// ── macOS 符号链接别名 ────────────────────────────────────────────────────────

/**
 * macOS 上 /tmp → /private/tmp、/var → /private/var 是常见符号链接。
 * realpathSync 会解析它们，导致与使用非 private 前缀构造的路径比较时失配，因此对两个方向都做规范化。
 */
export function normalizeMacOsSymlinks(p: string): string {
  return p
    .replace(/^\/private\/var(\/|$)/, '/var$1')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1');
}

// ── 符号链接感知的路径解析 ─────────────────────────────────────────────────────

/**
 * 返回原始路径以及其符号链接解析后的形式(若不同)。
 * 两者都必须通过全部权限检查，以防止此类符号链接逃逸攻击：
 *   ln -s /etc/passwd /workspace/.env
 *
 * 不存在的路径(例如将要创建的文件)只返回 [rawPath]。
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
    // 对解析后的形式同样应用 macOS 别名规范化
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

// ── 危险文件 / 目录常量 ────────────────────────────────────────────────────────

export const DANGEROUS_FILES: ReadonlySet<string> = new Set([
  '.gitconfig', '.gitcredentials', '.git-credentials',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
  '.env', '.env.local', '.env.production', '.env.development',
  '.mcp.json', '.ema-agent/settings.json',
  // Unix shell 配置——在 Windows 上通过 WSL / Git Bash 同样相关
  '.bashrc', '.bash_profile', '.bash_logout',
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  '.profile', '.tcshrc', '.cshrc', '.kshrc',
  // SSH 凭据
  '.ssh/config', '.ssh/authorized_keys', '.ssh/known_hosts',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);

export const DANGEROUS_DIRS: ReadonlySet<string> = new Set([
  '.git', '.ssh', '.gnupg', '.gpg',
  '.aws', '.azure', '.kube',
  '.ema-agent', 'node_modules',
  '__pycache__', '.venv', 'venv',
]);

// ── 通用安全检查(所有平台)────────────────────────────────────────────────────

function checkCommonSafety(p: string): string | undefined {
  if (p.includes('\0')) return 'path contains a null byte';
  if (/\$\{?[A-Za-z_]/.test(p) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(p))
    return 'path contains shell variable expansion';
  if (p.includes('=~')) return 'path contains shell expansion operator';
  if (/[*?[\]{},!]/.test(p)) return 'path contains glob metacharacters';
  return undefined;
}

// ── Windows / WSL 专属检查 ────────────────────────────────────────────────────

const DOS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
]);

/**
 * 检测 Windows / NTFS 路径攻击。
 * 在 'windows' 和 'wsl' 上都运行——WSL 上的 DrvFs 挂载会把文件操作
 * 路由到 Windows 内核，因此 ADS 冒号语法在那里仍会被解释执行。
 *
 * 覆盖范围：
 *   NTFS 备用数据流  (file.txt:stream — 仅 Windows/WSL)
 *   长路径 / 设备前缀  (\\?\ 或 \\.\ 或 //?/ 或 //./  )
 *   尾部点或空格      (绕过扩展名检查)
 *   8.3 短文件名      (PROGRA~1)
 *   DOS 设备名        (.git.CON)
 *   连续三个及以上点的路径组件
 *   UNC 路径 (所有平台上的纵深防御)
 */
export function hasSuspiciousWindowsPath(p: string): boolean {
  const platform = getPlatform();

  // ADS 冒号——仅 Windows 内核(Windows + WSL DrvFs)
  if (platform === 'windows' || platform === 'wsl') {
    if (p.indexOf(':', 2) !== -1) return true;
  }

  // 长路径 / 设备前缀(两种斜杠变体)
  if (
    p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\') ||
    p.startsWith('//?/')    || p.startsWith('//./')
  ) return true;

  // UNC 路径（所有平台，纵深防御）
  if ((p.startsWith('\\\\') || p.startsWith('//')) && p.length > 2) return true;

  // 尾部点或空白（Windows 在解析时会剥离这些字符）
  if (/[.\s]+$/.test(p)) return true;

  // 8.3 波浪号短文件名启发式
  if (/~\d/.test(p)) return true;

  // 路径组件中连续三个及以上的点
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(p)) return true;

  // DOS 设备名作为文件扩展名后缀（例如 .git.CON）
  if (/\.(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(p)) return true;

  // DOS 设备名作为路径段
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of segments) {
    const base = (seg.split('.')[0] ?? seg).toUpperCase();
    if (DOS_DEVICE_NAMES.has(base)) return true;
  }

  return false;
}

// ── Unix 专属检查 ─────────────────────────────────────────────────────────────

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

// ── 危险名称检查（所有平台）────────────────────────────────────────────────────

/**
 * 若路径按名称指向危险文件或目录，返回人类可读的原因；名称安全时返回 undefined。
 * 使用大小写不敏感比较，防止大小写混合绕过。
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

// ── 删除安全性 ────────────────────────────────────────────────────────────────

export function isDangerousRemovalPath(rawPath: string): boolean {
  if (rawPath === '*' || rawPath === '/*' || rawPath === '*.*') return true;

  const resolved = path.resolve(rawPath);
  const parts    = resolved.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return true;

  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (home && resolved === path.resolve(home)) return true;

  return false;
}

// ── Shell 展开辅助函数（导出）────────────────────────────────────────────────────

export function hasShellExpansion(p: string): boolean {
  return checkCommonSafety(p) !== undefined;
}

// ── 综合检查 ──────────────────────────────────────────────────────────────────

export interface PathSafetyResult {
  safe:    boolean;
  reason?: string;
}

/**
 * 完整的 bypass-immune 路径安全检查。
 * 在任何文件工具之前，对每个已解析路径（原始 + 符号链接）都执行。
 *
 * 顺序：
 *  1. 通用检查（空字节、shell 展开、glob 注入）
 *  2. 平台专属检查（Windows/WSL 或 Unix 虚拟文件系统）
 *  注意：危险文件/目录名在这里不检查——它们位于
 *  getDangerousPathReason() 中，并且只在流水线中拦截写入（不拦截读取）。
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
