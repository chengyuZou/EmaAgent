import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { getPlatform } from './platformPaths.js';

/**
 * 当前比较在 Windows/macOS 上忽略大小写, Linux/WSL 保留大小写.
 * 这是平台级选择, 不会查询具体磁盘是否启用了大小写敏感模式.
 */
export function normalizeCaseForComparison(p: string): string {
  const platform = getPlatform();
  return (platform === 'windows' || platform === 'macos') ? p.toLowerCase() : p;
}

/**
 * macOS 上 /tmp → /private/tmp, /var → /private/var 是常见符号链接.
 * realpathSync 会解析它们, 导致与使用非 private 前缀构造的路径比较时失配, 因此对两个方向都做规范化.
 */
export function normalizeMacOsSymlinks(p: string): string {
  return p
    .replace(/^\/private\/var(\/|$)/, '/var$1')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1');
}

/**
 * 返回绝对路径和解析后的路径, 供工具检查拒绝规则与工作区边界.
 * 新文件会解析最近存在的父目录, 再补回尚未创建的路径段.
 * 调用方必须先跳过网络路径, 避免在用户批准前查询远程资源.
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
    if (getPlatform() === 'macos') {
      paths.add(normalizeMacOsSymlinks(resolved));
    }
  } catch {
    // 卷或祖先路径不可访问时只返回原绝对路径, 这里不直接作出权限决定.
  }

  return [...paths];
}

/** 新文件自身不存在时, 解析最近存在的父目录, 防止通过父目录 symlink 越出 workspace. */
function resolveExistingPathOrAncestor(absolutePath: string): string {
  let cursor = absolutePath;
  const missingSegments: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`找不到可解析的路径祖先: ${absolutePath}`);
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }

  return path.join(fs.realpathSync(cursor), ...missingSegments);
}

export const DANGEROUS_FILES: ReadonlySet<string> = new Set([
  '.gitconfig', '.gitcredentials', '.git-credentials',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
  '.env', '.env.local', '.env.production', '.env.development',
  '.mcp.json', '.ema-agent/settings.json',
  // Windows 上的 Git Bash 和 WSL 也可能读取这些 Shell 配置.
  '.bashrc', '.bash_profile', '.bash_logout',
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout',
  '.profile', '.tcshrc', '.cshrc', '.kshrc',
  // SSH 凭据
  '.ssh/config', '.ssh/authorized_keys', '.ssh/known_hosts',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);

const DOS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON','PRN','AUX','NUL',
  'COM0','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9',
  'LPT0','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9',
]);

/**
 * 识别需要确认的设备路径, UNC, 短名, 尾部点或空白等写法.
 * ADS 冒号检查只在 Windows/WSL 执行, 其他名称检查在所有平台执行.
 * 返回 true 只表示可疑, 最终询问或拒绝由工具决定.
 */
export function hasSuspiciousWindowsPath(p: string): boolean {
  const platform = getPlatform();

  // WSL 的 Windows 挂载路径也可能解释 NTFS 备用数据流语法.
  if (platform === 'windows' || platform === 'wsl') {
    if (p.indexOf(':', 2) !== -1) return true;
  }

  // 长路径 / 设备前缀(两种斜杠变体)
  if (
    p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\') ||
    p.startsWith('//?/')    || p.startsWith('//./')
  ) return true;

  // 所有平台都识别 UNC 写法, 避免把网络地址当作普通本地路径.
  if ((p.startsWith('\\\\') || p.startsWith('//')) && p.length > 2) return true;

  // 尾部点和空白可能使 Windows 解析出的名称与输入不同.
  if (/[.\s]+$/.test(p)) return true;

  // 8.3 波浪号短文件名启发式
  if (/~\d/.test(p)) return true;

  // 路径组件中连续三个及以上的点
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(p)) return true;

  // DOS 设备名作为扩展名后缀, 如 .git.CON.
  if (/\.(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(p)) return true;

  // DOS 设备名作为路径段
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of segments) {
    const base = (seg.split('.')[0] ?? seg).toUpperCase();
    if (DOS_DEVICE_NAMES.has(base)) return true;
  }

  return false;
}
