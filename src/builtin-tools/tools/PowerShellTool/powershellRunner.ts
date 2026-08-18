// PowerShell 命令执行引擎:直接起探测到的 pwsh/powershell 进程。
// 不走 sandbox CommandRunner——那里是 bash ShellSpec;裸 Windows 本就没有 OS 级隔离,
// 本工具的安全由 AST 分析 + 逐条权限提供(这是"无沙箱路线"的诚实形态)。
// 若未来 sandbox 包支持 powershell ShellSpec,再迁回统一执行路径。
import { spawn } from 'node:child_process';

/** 单流内存上限:超出即截断。模型预算(50KB)由结果层在外侧另算。 */
const MAX_STREAM_BYTES = 256 * 1024;

export interface PowerShellRunResult {
  stdout: string;
  stderr: string;
  /** 进程自身退出码;被取消/超时杀死为 -1。 */
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  /** 任一输出流触及内存上限。 */
  truncated: boolean;
}

export interface PowerShellRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * 统一让子进程以 UTF-8 输出:Windows PowerShell 5.1 的默认控制台编码是 OEM
 * 代码页(中文 Windows 是 GBK),不处理会把中文输出解码成乱码发给模型。
 * 包装发生在权限裁决之后,不进入 AST 分析面。
 */
function wrapForUtf8(command: string): string {
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
}

/** 杀掉整棵进程树:Windows 用 taskkill /T,POSIX 用进程组负 pid。 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // taskkill 失败(进程已退等)无害,不等待结果。
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      .on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 进程已退 */ }
  }
}

/**
 * 执行一条 PowerShell 命令并收集有界输出。
 * 终态只结算一次:超时与外部取消互斥(超时优先),启动失败直接 reject。
 */
export function runPowerShellCommand(
  shellPath: string,
  command: string,
  options: PowerShellRunOptions,
): Promise<PowerShellRunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-NoLogo',
      '-Command',
      wrapForUtf8(command),
    ];
    // POSIX 侧 detached 以便按进程组杀;Windows 忽略该选项,用 taskkill /T。
    const child = spawn(shellPath, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const settle = (result: PowerShellRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stdoutBytes += chunk.length;
      stdout += chunk.toString('utf8');
      if (stdoutBytes > MAX_STREAM_BYTES) truncated = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stderrBytes += chunk.length;
      stderr += chunk.toString('utf8');
      if (stderrBytes > MAX_STREAM_BYTES) truncated = true;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code) => {
      settle({
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}
