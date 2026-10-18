import path from 'node:path';
import { statSync } from 'node:fs';
import type { SandboxBackend, SandboxConfig, ShellSpec, WrappedCommand } from '../types.js';
import { getPlatform, type SandboxPlatform } from '../discovery/platform.js';

/**
 * 先将根文件系统设为只读, 再叠加可写目录, 只读路径和隐藏路径.
 * Windows 经默认 WSL 发行版启动, 本机路径按 /mnt/<drive>/... 转换.
 */
export class BubblewrapBackend implements SandboxBackend {
  wrap(command: string, shell: ShellSpec, config: SandboxConfig): WrappedCommand {
    return buildBubblewrapCommand(command, shell, config, getPlatform());
  }
}

/** 后端执行与启动自检共用同一套直启和 WSL 包装规则. */
export function buildBubblewrapCommand(
  command: string,
  shell: ShellSpec,
  config: SandboxConfig,
  platform: SandboxPlatform,
): WrappedCommand {
  if (platform === 'windows') {
    return wrapViaWsl(command, config);
  }

  // 原生 Linux / WSL2: 结构化 argv 直启 bwrap, 路径无需任何引号转义.
  // 非 Windows 平台上 shell 恒为 native 路径; wsl 形态在此不可达, 防御性回退.
  const shellPath = shell.kind === 'native' ? shell.path : 'bash';
  return {
    executable: 'bwrap',
    args: [...buildBwrapArgs(config), '--', shellPath, '-c', command],
  };
}

/**
 * 生成 bwrap 隔离参数. resolvePaths=true 时把配置路径解析为绝对路径
 * (直启路径); WSL 路径已翻译为 POSIX 形式, 不能再经宿主 path.resolve.
 * isDirectory 分类器可覆盖默认 statSync 判定: WSL 下 Linux 路径在
 * Windows 宿主上 statSync 必然失真, 必须在翻译前判定后传入.
 */
function buildBwrapArgs(
  config: SandboxConfig,
  opts: { resolvePaths?: boolean; isDirectory?: (p: string) => boolean } = {},
): string[] {
  const resolvePath = (p: string): string => (opts.resolvePaths === false ? p : path.resolve(p));
  const isDir = opts.isDirectory ?? isDirectory;
  const args: string[] = [
    '--ro-bind', '/', '/',        // 整个文件系统只读
    '--dev',     '/dev',          // 设备(很多工具需要)
    '--proc',    '/proc',         // /proc(ps 等需要)
    '--die-with-parent',          // 父进程退出时杀掉沙箱进程
  ];

  // 可写目录(覆盖只读根绑定)
  for (const p of config.filesystem.allowWrite) {
    const r = resolvePath(p);
    args.push('--bind-try', r, r);
  }

  // 显式只读路径(叠在任意 allowWrite 父目录之上)
  for (const p of config.filesystem.denyWrite) {
    const r = resolvePath(p);
    args.push('--ro-bind-try', r, r);
  }

  // 隐藏路径: 文件挂 /dev/null 覆盖; 目录挂空 tmpfs 遮蔽内容
  // (/dev/null 是文件, 盖不住目录).
  for (const p of config.filesystem.denyRead) {
    const r = resolvePath(p);
    if (isDir(r)) {
      args.push('--tmpfs', r);
    } else {
      args.push('--bind-try', '/dev/null', r);
    }
  }

  // full 不添加断网参数; none 使用独立网络 namespace.
  if (config.network.access === 'none') {
    args.push('--unshare-net');
  }

  return args;
}

function wrapViaWsl(command: string, config: SandboxConfig): WrappedCommand {
  // 把 Win32 路径翻译成 /mnt/<drive>/..., 供 WSL 内的 bwrap 使用
  const translatedConfig: SandboxConfig = {
    filesystem: {
      allowWrite: config.filesystem.allowWrite.map(toWslPath),
      denyWrite:  config.filesystem.denyWrite.map(toWslPath),
      denyRead:   config.filesystem.denyRead.map(toWslPath),
    },
    network: config.network,
  };

  // 目录判定必须在翻译前做: Windows 宿主 statSync 不了 /mnt/<drive> 路径.
  const dirByTranslated = new Map<string, boolean>();
  for (const p of config.filesystem.denyRead) {
    dirByTranslated.set(toWslPath(p), isDirectory(p));
  }

  // wsl.exe 会把 argv 拼成单行命令交给 Linux 进程, 路径与命令必须引号保护.
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
 * 按默认 /mnt/<drive> 布局转换盘符路径. 不查询 WSL 实际挂载配置.
 * UNC 路径保持原样, 本后端没有提供将其挂载进 WSL 的处理.
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

/** 嵌入 Bash -c 字符串前, 转义单引号并包裹整个参数. */
function escapeForShell(command: string): string {
  return `'${command.replace(/'/g, "'\\''")}'`;
}

/** 为嵌入 shell -c 字符串的参数加引号(仅 WSL 拼串路径使用). */
function qp(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** 路径是否为目录(不存在时按文件处理, 走 /dev/null 覆盖). */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
