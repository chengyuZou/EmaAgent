import { execFile } from 'node:child_process';
import {
  GitCommandError,
  GitOutputTooLargeError,
  GitTimeoutError,
  GitUnavailableError,
} from './errors.js';

const GIT_READ_TIMEOUT_MS = 100_000;
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// 将 hooksPath 指向空设备, 避免后台命令执行仓库配置的 hook.
const DISABLED_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunGitOptions {
  /** 额外接受的退出码. git diff --no-index 用 1 表示有差异, 仍有可用输出. */
  readonly allowedExitCodes?: readonly number[];
  /** 每个输出流的缓冲上限, 单位为字节. 缺省使用 GIT_MAX_OUTPUT_BYTES. */
  readonly maxOutputBytes?: number;
  /** -c key=value 配置, 放在内置配置之后生效. 基线写入用它指定作者和关闭签名. */
  readonly extraConfig?: readonly string[];
  /** 毫秒数, 缺省使用 GIT_READ_TIMEOUT_MS. 基线写入另行指定超时. */
  readonly timeoutMs?: number;
}

export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c', `core.hooksPath=${DISABLED_HOOKS_PATH}`,
        // fsmonitor 可以指向外部程序, 后台查询关闭它以免执行仓库配置的程序.
        '-c', 'core.fsmonitor=false',
        ...(options.extraConfig?.flatMap((cfg) => ['-c', cfg]) ?? []),
        ...args,
      ],
      {
        cwd,
        timeout: options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
        maxBuffer: options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          // 跳过只读命令可省略的索引刷新锁. add/commit 等写入仍使用正常的 Git 锁.
          GIT_OPTIONAL_LOCKS: '0',
          // 后台调用没有可供用户输入的终端, 禁用 Git 的终端凭据提问.
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        if (err.code === 'ENOENT') {
          reject(new GitUnavailableError());
          return;
        }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new GitOutputTooLargeError(args.join(' '), options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES));
          return;
        }
        if (err.killed) {
          reject(new GitTimeoutError(args.join(' '), options.timeoutMs ?? GIT_READ_TIMEOUT_MS));
          return;
        }
        if (typeof err.code === 'number' && options.allowedExitCodes?.includes(err.code)) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new GitCommandError(
          args.join(' '),
          err.code ?? 'unknown',
          stderr,
        ));
      },
    );
  });
}
