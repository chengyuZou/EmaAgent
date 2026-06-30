import { spawn } from 'node:child_process';
import type { RunResult } from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 200_000;

// ── Canonical process spawner ─────────────────────────────────────────────────

/**
 * Spawn `executable args` and collect stdout/stderr with timeout + abort support.
 *
 * Single source of truth shared by bash.ts (runShell) and sandbox/manager.ts —
 * eliminates the ~70-line duplication between the two packages.
 *
 * @param executable  Absolute or PATH-resolvable executable (e.g. '/bin/bash', 'powershell.exe').
 * @param args        Arguments to pass to the executable.
 * @param cwd         Working directory for the child process.
 * @param timeoutMs   Hard kill timeout in milliseconds.
 * @param signal      Optional AbortSignal wired to turn cancellation.
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
        const notice = `\n[Output truncated: ${totalChars.toLocaleString()} chars → ${MAX_OUTPUT_CHARS.toLocaleString()} chars shown. Refine your command to see specific content.]`;
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
