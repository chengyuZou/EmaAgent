// 用 Bubblewrap 在 Linux 或 WSL2 中隔离命令的文件和网络访问。

import path from 'node:path';
import { statSync } from 'node:fs';
import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';
import { getPlatform, type SandboxPlatform } from '../platform.js';

/**
 * Linux 和 WSL2（含 Windows 经 WSL2）的 Bubblewrap 后端。
 *
 * 策略：
 *   1. `--ro-bind / /` - 沙箱内整个文件系统只读
 *   2. `--bind <allowWrite> <allowWrite>` - 覆盖特定目录为可写
 *   3. `--ro-bind-try <denyWrite> <denyWrite>` - 对特定路径重新强制只读
 *      （捕获 allowWrite 是 denyWrite 父目录的情况）
 *   4. `--unshare-net` - 网络隔离
 *
 * 原生 Linux 直接以 argv 启动 bwrap（不经外层 Shell 拼串）；
 * Windows 经 wsl.exe 路由，路径翻译成 /mnt/<drive>/...，参数仍需引号
 * （wsl.exe 把 argv 拼成单行命令传给 Linux 进程）。
 */
export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap';

  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand {
    return buildBubblewrapCommand(command, shell, config, getPlatform());
  }
}

/** 平台相关的 bwrap 启动形态（导出供单测覆盖直启与 WSL 两条路径）。 */
export function buildBubblewrapCommand(
  command: string,
  shell: string,
  config: SandboxConfig,
  platform: SandboxPlatform,
): WrappedCommand {
  if (platform === 'windows') {
    return wrapViaWsl(command, shell, config);
  }

  // 原生 Linux / WSL2: 结构化 argv 直启 bwrap, 路径无需任何引号转义。
  return {
    executable: 'bwrap',
    args: [...buildBwrapArgs(config), '--', shell, '-c', command],
  };
}

// ── bwrap argument builder ────────────────────────────────────────────────────

/**
 * 生成 bwrap 隔离参数。resolvePaths=true 时把配置路径解析为绝对路径
 * (直启路径); WSL 路径已翻译为 POSIX 形式, 不能再经宿主 path.resolve。
 * isDirectory 分类器可覆盖默认 statSync 判定——WSL 下 Linux 路径在
 * Windows 宿主上 statSync 必然失真, 必须在翻译前判定后传入。
 */
function buildBwrapArgs(
  config: SandboxConfig,
  opts: { resolvePaths?: boolean; isDirectory?: (p: string) => boolean } = {},
): string[] {
  const resolvePath = (p: string): string => (opts.resolvePaths === false ? p : path.resolve(p));
  const isDir = opts.isDirectory ?? isDirectory;
  const args: string[] = [
    '--ro-bind', '/', '/',        // 整个文件系统只读
    '--dev',     '/dev',          // 设备（很多工具需要）
    '--proc',    '/proc',         // /proc（ps 等需要）
    '--die-with-parent',          // 父进程退出时杀掉沙箱进程
  ];

  // 可写目录（覆盖只读根绑定）
  for (const p of config.filesystem.allowWrite) {
    const r = resolvePath(p);
    args.push('--bind-try', r, r);
  }

  // 显式只读路径（叠在任意 allowWrite 父目录之上）
  for (const p of config.filesystem.denyWrite) {
    const r = resolvePath(p);
    args.push('--ro-bind-try', r, r);
  }

  // 隐藏路径: 文件挂 /dev/null 覆盖; 目录挂空 tmpfs 遮蔽内容
  // (/dev/null 是文件, 盖不住目录)。
  for (const p of config.filesystem.denyRead) {
    const r = resolvePath(p);
    if (isDir(r)) {
      args.push('--tmpfs', r);
    } else {
      args.push('--bind-try', '/dev/null', r);
    }
  }

  // 网络隔离
  // V1 只支持完全断网或全网访问；域名级过滤需要独立网络代理。
  if (config.network.access === 'none') {
    args.push('--unshare-net');
  }

  return args;
}

// ── Windows / WSL path translation ───────────────────────────────────────────

function wrapViaWsl(command: string, shell: string, config: SandboxConfig): WrappedCommand {
  // 把 Win32 路径翻译成 /mnt/<drive>/...，供 WSL 内的 bwrap 使用
    const translatedConfig: SandboxConfig = {
    filesystem: {
      allowWrite: config.filesystem.allowWrite.map(toWslPath),
      denyWrite:  config.filesystem.denyWrite.map(toWslPath),
      denyRead:   config.filesystem.denyRead.map(toWslPath),
    },
    network: config.network,
  };

  // 目录判定必须在翻译前做: Windows 宿主 statSync 不了 /mnt/<drive> 路径。
  const dirByTranslated = new Map<string, boolean>();
  for (const p of config.filesystem.denyRead) {
    dirByTranslated.set(toWslPath(p), isDirectory(p));
  }

  // wsl.exe 会把 argv 拼成单行命令交给 Linux 进程, 路径与命令必须引号保护。
  const quotedArgs = buildBwrapArgs(translatedConfig, {
    resolvePaths: false,
    isDirectory: (p) => dirByTranslated.get(p) ?? false,
  }).map(qp);
  const escaped    = escapeForShell(command);
  const wslShell   = 'bash';

  return {
    executable: 'wsl.exe',
    args: ['bash', '-c', `bwrap ${quotedArgs.join(' ')} -- ${wslShell} -c ${escaped}`],
  };
}

/**
 * 把 Win32 路径翻译成 WSL /mnt/<drive> 等价路径。
 * UNC 路径（\\server\share）原样返回 - WSL 内的 bwrap 无法 bind-mount 它们，
 * 会落到 app-layer 执行。
 */
function toWslPath(winPath: string): string {
  // UNC 路径 - 无法翻译
  if (winPath.startsWith('\\\\')) return winPath;

  const match = winPath.match(/^([A-Za-z]):[/\\](.*)$/);
  if (!match) return winPath;

  const drive = match[1]!.toLowerCase();
  const rest  = match[2]!.replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

// ── Shell escaping ────────────────────────────────────────────────────────────

/** 用单引号包裹命令，转义内嵌单引号。 */
function escapeForShell(command: string): string {
  return `'${command.replace(/'/g, "'\\''")}'`;
}

/** 为嵌入 shell -c 字符串的参数加引号（仅 WSL 拼串路径使用）。 */
function qp(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** 路径是否为目录(不存在时按文件处理, 走 /dev/null 覆盖)。 */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
