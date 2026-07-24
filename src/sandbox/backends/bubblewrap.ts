// 用 Bubblewrap 在 Linux 或 WSL2 中隔离命令的文件和网络访问。

import path from 'node:path';
import type { SandboxBackend, SandboxConfig, WrappedCommand } from '../types.js';
import { getPlatform } from '../platform.js';

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
 * Windows 上经 wsl.exe 路由，并把 Win32 路径翻译成 WSL /mnt/<drive>/... 后再构建 bwrap 参数。
 */
export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap';

  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand {
    const platform = getPlatform();

    if (platform === 'windows') {
      return wrapViaWsl(command, shell, config);
    }

    const bwrapArgs = buildBwrapArgs(config);
    const escaped   = escapeForShell(command);

    return {
      executable: shell,
      args: ['-c', `bwrap ${bwrapArgs.join(' ')} -- ${shell} -c ${escaped}`],
    };
  }
}

// ── bwrap argument builder ────────────────────────────────────────────────────

function buildBwrapArgs(config: SandboxConfig): string[] {
  const args: string[] = [
    '--ro-bind', qp('/'), qp('/'),   // 整个文件系统只读
    '--dev',     qp('/dev'),         // 设备（很多工具需要）
    '--proc',    qp('/proc'),        // /proc（ps 等需要）
    '--die-with-parent',             // 父进程退出时杀掉沙箱进程
  ];

  // 可写目录（覆盖只读根绑定）
  for (const p of config.filesystem.allowWrite) {
    const r = qp(path.resolve(p));
    args.push('--bind-try', r, r);
  }

  // 显式只读路径（叠在任意 allowWrite 父目录之上）
  for (const p of config.filesystem.denyWrite) {
    const r = qp(path.resolve(p));
    args.push('--ro-bind-try', r, r);
  }

  // 隐藏路径（挂载 /dev/null 覆盖）
  for (const p of config.filesystem.denyRead) {
    args.push('--bind-try', qp('/dev/null'), qp(path.resolve(p)));
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
      allowRead:  config.filesystem.allowRead.map(toWslPath),
    },
    network: config.network,
  };

  const bwrapArgs = buildBwrapArgs(translatedConfig);
  const escaped   = escapeForShell(command);
  // WSL 内的 shell 固定为 bash；路径参数已由 buildBwrapArgs 的 qp() 转义
  const wslShell  = 'bash';

  return {
    executable: 'wsl.exe',
    args: ['bash', '-c', `bwrap ${bwrapArgs.join(' ')} -- ${wslShell} -c ${escaped}`],
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

/**
 * 为嵌入 shell -c 字符串的文件系统路径加引号。
 * 防止路径中的空格或特殊字符（如工作区在 "/home/user/My Projects/foo"）
 * 被外层 shell 误分词。
 */
function qp(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}
