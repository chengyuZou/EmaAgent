// PowerShell 可执行文件探测:优先 pwsh(7+),回退 Windows 随箱的 powershell.exe(5.1)。
// 对照 Claude src/utils/shell/powershellDetection.ts;which 改用 node:child_process 实现。
// 模块加载即预热(registerBuiltinTools 时),首个 Turn 装配前探测早已结算。
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';

export type PowerShellEdition = 'core' | 'desktop';

export interface PowerShellDetection {
  /** 可执行文件真实路径;未安装为 null。 */
  readonly path: string | null;
  /** 由二进制名推断版本:pwsh→core(支持 &&/||/三元);powershell→desktop(5.1)。不起进程。 */
  readonly edition: PowerShellEdition | null;
}

/** PATH 查找:Windows 用 where.exe 取首行,POSIX 用 which。找不到返回 null,不抛。 */
function which(command: string): Promise<string | null> {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      isWin ? 'where.exe' : 'which',
      [command],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }
        const first = stdout.trim().split(/\r?\n/)[0];
        resolve(first || null);
      },
    );
  });
}

async function probePath(p: string): Promise<string | null> {
  try {
    return (await stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Linux 上 PATH 若解析到 snap 启动器(/snap/...,含 /usr/bin/pwsh 符号链接到 snap 的情况),
 * 直接起子进程可能在 snapd 初始化 confinement 时挂死;改探 apt/rpm 的真实安装位置。
 * Windows/macOS 无此问题,PATH 结果直接用。
 */
async function findPowerShell(): Promise<string | null> {
  const pwshPath = await which('pwsh');
  if (pwshPath) {
    if (process.platform === 'linux') {
      const resolved = await realpath(pwshPath).catch(() => pwshPath);
      if (pwshPath.startsWith('/snap/') || resolved.startsWith('/snap/')) {
        const direct =
          (await probePath('/opt/microsoft/powershell/7/pwsh'))
          ?? (await probePath('/usr/bin/pwsh'));
        if (direct) {
          const directResolved = await realpath(direct).catch(() => direct);
          if (!direct.startsWith('/snap/') && !directResolved.startsWith('/snap/')) {
            return direct;
          }
        }
      }
    }
    return pwshPath;
  }
  // Windows 随箱 5.1;POSIX 上若用户自装了 Windows PowerShell 同名命令也接受。
  return which('powershell');
}

let cached: Promise<PowerShellDetection> | null = null;
let settled: PowerShellDetection | undefined;

async function detect(): Promise<PowerShellDetection> {
  const path = await findPowerShell();
  const result: PowerShellDetection = { path, edition: inferEdition(path) };
  settled = result;
  return result;
}

/**
 * PowerShell 6 同样叫 pwsh 但不支持 &&,已 EOL 多年,不作为现实安装目标,
 * 故 core 可以安全地按 7+ 语义对待。
 */
function inferEdition(path: string | null): PowerShellEdition | null {
  if (!path) return null;
  const base = path.split(/[/\\]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  return base === 'pwsh' ? 'core' : 'desktop';
}

/** 缓存的探测 Promise;同一进程只探测一次。 */
export function detectPowerShell(): Promise<PowerShellDetection> {
  if (!cached) cached = detect();
  return cached;
}

/** 装配期同步窥视:未结算返回 undefined(调用方按 fail-closed 处理)。 */
export function peekPowerShellDetection(): PowerShellDetection | undefined {
  return settled;
}

/** 仅测试与 shell 安装引导后的重探使用。 */
export function resetPowerShellDetection(): void {
  cached = null;
  settled = undefined;
}

// 模块加载即预热:让探测在首次装配 ToolPool 之前完成。
void detectPowerShell();
