// 统一封装 git CLI 调用:不经过 shell、超时即杀、输出有界,并屏蔽仓库自定义 hook 与索引锁。
// 安全约束与 codex git-utils 一致:只读查询绝不能触发仓库配置的 hook,也不抢 .git/index.lock。
import { execFile } from 'node:child_process';
import { GitError } from './errors.js';

const GIT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** 让内部查询绕过仓库 hooksPath;Windows 空设备为 NUL,其余为 /dev/null。 */
const DISABLED_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunGitOptions {
  /** 视为成功的额外退出码;git diff --no-index 有差异时以 1 退出,属正常输出。 */
  readonly allowedExitCodes?: readonly number[];
  /** 单次输出上限,默认 4MB;合并 patch 可能超过默认值,调用方显式抬高。 */
  readonly maxOutputBytes?: number;
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
        // 仓库可配置任意 fsmonitor 可执行 helper,内部查询一律禁用,不移植 codex 的探测逻辑。
        '-c', 'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          // 只读命令不获取可选锁,避免与用户的 git 操作互相阻塞。
          GIT_OPTIONAL_LOCKS: '0',
          // 禁止 git 因凭据等问题弹出终端交互,查询必须当场失败而不是挂起。
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
          reject(new GitError('git/unavailable', 'git: executable not found on PATH'));
          return;
        }
        if (err.killed) {
          reject(new GitError('git/timeout', `git ${args.join(' ')}: timed out after ${GIT_TIMEOUT_MS}ms`));
          return;
        }
        if (typeof err.code === 'number' && options.allowedExitCodes?.includes(err.code)) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new GitError(
          'git/command-failed',
          `git ${args.join(' ')}: exit ${err.code ?? 'unknown'}`,
          stderr.trim() || undefined,
        ));
      },
    );
  });
}
