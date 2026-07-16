// 这里统一启动受控子进程，并处理输出上限、超时和取消信号。
import { spawn } from 'node:child_process';
import type { RunResult } from './types.js';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 200_000;

// ── 规范进程 spawner ──────────────────────────────────────────────────────────

/**
 * spawn `executable args` 并收集 stdout/stderr,支持超时 + 中止。
 *
 * BashTool(runShell)和 sandbox/manager.ts 共用的单一事实源 -
 * 消除两包间约 70 行重复。
 *
 * @param executable  绝对路径或 PATH 可解析的可执行文件(如 '/bin/bash'、'powershell.exe')。
 * @param args        传给可执行文件的参数。
 * @param cwd         子进程工作目录。
 * @param timeoutMs   硬杀超时(毫秒)。
 * @param signal      可选 AbortSignal,接 turn 取消。
 */
export function spawnProcess(
  executable: string,
  args:       string[],
  cwd:        string,
  timeoutMs:  number,
  signal:     AbortSignal | undefined,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env, TERM: 'dumb' },
    });

    let stdout   = '';
    let stderr   = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, 3_000);
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      const aborted    = !timedOut && (signal?.aborted ?? false);
      const totalChars = stdout.length + stderr.length;
      const truncated  = totalChars > MAX_OUTPUT_CHARS;
      if (truncated) {
        const keep   = MAX_OUTPUT_CHARS / 2;
        const notice = `\n[Output truncated: ${totalChars.toLocaleString()} chars -> ${MAX_OUTPUT_CHARS.toLocaleString()} chars shown. Refine your command to see specific content.]`;
        stdout = stdout.slice(0, keep) + (stdout.length > keep ? notice : '');
        stderr = stderr.slice(0, keep) + (stderr.length > keep ? notice : '');
      }

      resolve({
        stdout:   stdout.trimEnd(),
        stderr:   stderr.trimEnd(),
        exitCode: code ?? -1,
        timedOut,
        truncated,
        aborted,
      });
    });
  });
}
