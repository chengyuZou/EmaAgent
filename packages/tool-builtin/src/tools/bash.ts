import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_OUTPUT_CHARS = 200_000;

/**
 * Commands that must never execute — even in bypass mode.
 * These could cause irreversible system damage.
 */
const BANNED_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive.*--force|--force.*--recursive)\b/i,
  /\bformat\s+(c:|\/dev\/)/i,
  /\bmkfs\b/i,
  /:\(\)\{\s*:\|:\s*&\s*\};:/,  // fork bomb
  /\bdd\s+.*of=\/dev\/(s|h)d/i,
  /\bsudo\s+rm\b/i,
];

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command to execute. Avoid interactive commands that require stdin.'),
  description: z
    .string()
    .optional()
    .describe('Brief description of what this command does (shown in permission dialogs).'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}. Max ${MAX_TIMEOUT_MS}.`),
  run_in_background: z
    .boolean()
    .default(false)
    .describe('Fire-and-forget. Returns immediately; stdout/stderr are not captured.'),
});

type BashInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const bashTool = buildTool<BashInput, BashResult>({
  name: 'bash',
  description: `Execute a bash/sh shell command and return stdout, stderr, and exit code.

Safety rules:
- Avoid interactive commands that read from stdin (they will hang).
- Destructive patterns (recursive force-delete, mkfs, fork bombs, etc.) are blocked regardless of permission mode.
- Commands are executed inside the workspace root as the working directory.
- Timeout defaults to 2 minutes; use \`run_in_background: true\` for long-running daemons.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
    bypassImmune: true, // safety check runs even in bypass mode
    safetyCheck: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return 'continue';
      const { command } = parsed.data;
      for (const re of BANNED_COMMAND_PATTERNS) {
        if (re.test(command)) return 'deny';
      }
      return 'continue';
    },
  },

  async execute(input: BashInput, ctx: ToolExecutionContext): Promise<BashResult> {
    const { command, timeout, run_in_background } = input;

    // Safety check duplicated here so it also fires when dispatched directly
    for (const re of BANNED_COMMAND_PATTERNS) {
      if (re.test(command)) {
        throw new Error(`Command blocked by safety policy: ${command}`);
      }
    }

    const shell = process.platform === 'win32' ? 'bash' : '/bin/bash';
    const cwd = ctx.workspaceRoot;
    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    if (run_in_background) {
      spawn(shell, ['-c', command], {
        cwd,
        stdio: 'ignore',
        detached: true,
      }).unref();
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }

    return runShell(shell, ['-c', command], cwd, timeoutMs, ctx.signal);
  },
});

// ── runShell ─────────────────────────────────────────────────────────────────

export function runShell(
  shell: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BashResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(shell, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      proc.kill('SIGTERM');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);

      const combined = stdout + stderr;
      const truncated = combined.length > MAX_OUTPUT_CHARS;

      if (truncated) {
        const keep = MAX_OUTPUT_CHARS / 2;
        stdout = stdout.slice(0, keep);
        stderr = stderr.slice(0, keep);
      }

      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
        timedOut,
        truncated,
      });
    });
  });
}
