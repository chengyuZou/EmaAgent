// 启动沙箱包装后的子进程，并统一处理输出上限、超时和取消。

import { spawn } from 'node:child_process';
import type { CommandRunResult } from './types.js';

const MAX_OUTPUT_CHARS = 200_000;
const MAX_STREAM_CHARS = MAX_OUTPUT_CHARS / 2;
const FORCE_KILL_DELAY_MS = 3_000;

export function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
    });

    let stdout = '';
    let stderr = '';
    let stdoutChars = 0;
    let stderrChars = 0;
    let timedOut = false;
    let settled = false;

    const forceKill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已经退出。
      }
    };
    const terminate = (): void => {
      child.kill('SIGTERM');
      const forceKillTimer = setTimeout(forceKill, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
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
      const text = chunk.toString();
      stdoutChars += text.length;
      stdout = appendBounded(stdout, text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChars += text.length;
      stderr = appendBounded(stderr, text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);

      const aborted = !timedOut && (signal?.aborted ?? false);
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
}

function appendBounded(current: string, incoming: string): string {
  const combined = current + incoming;
  if (combined.length <= MAX_STREAM_CHARS) return combined;

  const headChars = MAX_STREAM_CHARS / 2;
  const tailChars = MAX_STREAM_CHARS - headChars;
  return combined.slice(0, headChars) + combined.slice(-tailChars);
}
