// 启动沙箱包装后的子进程，并统一处理输出上限、超时和取消。
// 只执行 SandboxCommand: 不读取 process.env, 不理解 Sandbox Policy。

import { spawn, spawnSync } from 'node:child_process';
import type {
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunResult,
  SandboxCommand,
} from './types.js';

const MAX_OUTPUT_CHARS = 200_000;
const MAX_STREAM_CHARS = MAX_OUTPUT_CHARS / 2;
const FORCE_KILL_DELAY_MS = 3_000;

export function runProcess(
  command: SandboxCommand,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (chunk: CommandOutputChunk) => void,
): Promise<CommandRunResult> {
  return startProcess(command, timeoutMs, signal, onOutput).completion;
}

export function startProcess(
  command: SandboxCommand,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (chunk: CommandOutputChunk) => void,
): CommandProcessHandle {
  let stopProcess = (): void => undefined;
  const completion = new Promise<CommandRunResult>((resolve, reject) => {
    // 已取消的 signal 不启动进程, 诚实返回取消结果而不是"先启动再杀"。
    if (signal?.aborted) {
      resolve({
        stdout: '', stderr: '', exitCode: -1,
        timedOut: false, truncated: false, aborted: true,
      });
      return;
    }

    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...command.environment },
      // POSIX: 独立进程组, 终止时整组(SIGTERM→SIGKILL)而不是只杀包装进程。
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stdoutChars = 0;
    let stderrChars = 0;
    let timedOut = false;
    let stopped = false;
    let settled = false;

    /**
     * 终止整棵进程树。Windows 无 POSIX 进程组: taskkill /T /F 是唯一真实的
     * 树终止(立即, 不伪装宽限期); WSL 经 wsl.exe 转发, 尽力而为。
     * POSIX: 负 pid 打整个进程组, TERM 宽限后 KILL。
     */
    const terminateTree = (force: boolean): void => {
      if (process.platform === 'win32') {
        if (child.pid === undefined) return;
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // 进程可能已经退出。
        }
        return;
      }
      try {
        process.kill(-child.pid!, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // 进程组已经退出。
      }
    };

    // 终止流程只进一次; 延迟强杀定时器在 close/error 时统一清除——
    // 进程提前退出后 PGID 可能被系统复用, 迟到的 SIGKILL 会误杀无关进程。
    let terminating = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const clearForceKillTimer = (): void => {
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      terminateTree(false);
      forceKillTimer = setTimeout(() => terminateTree(true), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    };
    stopProcess = (): void => {
      stopped = true;
      clearTimeout(timeout);
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = (): void => {
      clearTimeout(timeout);
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      onOutput?.({ stream: 'stdout', data: chunk });
      const text = chunk.toString();
      stdoutChars += text.length;
      stdout = appendBounded(stdout, text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      onOutput?.({ stream: 'stderr', data: chunk });
      const text = chunk.toString();
      stderrChars += text.length;
      stderr = appendBounded(stderr, text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearForceKillTimer();
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearForceKillTimer();
      signal?.removeEventListener('abort', onAbort);

      const aborted = !timedOut && (stopped || (signal?.aborted ?? false));
      const totalChars = stdoutChars + stderrChars;
      const truncated = stdoutChars > stdout.length || stderrChars > stderr.length;
      if (truncated) {
        const notice =
          `\n[输出已截断：原始 ${totalChars.toLocaleString()} 字符，`
          + `仅保留开头与结尾。请缩小命令范围。]`;
        if (stdoutChars > stdout.length) stdout += notice;
        if (stderrChars > stderr.length) stderr += notice;
      }

      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
        timedOut,
        truncated,
        aborted,
      });
    });
  });
  return Object.freeze({
    completion,
    stop: () => stopProcess(),
  });
}

function appendBounded(current: string, incoming: string): string {
  const combined = current + incoming;
  if (combined.length <= MAX_STREAM_CHARS) return combined;

  const headChars = MAX_STREAM_CHARS / 2;
  const tailChars = MAX_STREAM_CHARS - headChars;
  return combined.slice(0, headChars) + combined.slice(-tailChars);
}
