import { spawn }      from 'node:child_process';
import type { PermissionEngine } from '@ema-agent/permission';
import type { SandboxBackend, SandboxConfig, RunOptions, RunResult } from './types.js';
import { detectBackend }           from './detect.js';
import { buildSandboxConfig, scrubPlantedFiles } from './config-builder.js';
import { AppLayerBackend }         from './backends/app-layer.js';
import { BubblewrapBackend }       from './backends/bubblewrap.js';
import { SandboxExecBackend }      from './backends/sandbox-exec.js';
import type { ConfigContext }      from './config-builder.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS     = 600_000;
const MAX_OUTPUT_CHARS   = 200_000;

// ── CommandRunner ─────────────────────────────────────────────────────────────

export interface CommandRunnerOptions {
  workspaceRoot:          string;
  additionalWorkingDirs?: string[];
  sessionId?:            string;
  /** Live permission engine — rules are re-read on every refreshConfig(). */
  permission:            PermissionEngine;
}

/**
 * Per-session shell execution engine with OS-level sandboxing.
 *
 * Lifecycle (matches software session):
 *   new CommandRunner(opts) → initialize state
 *   .run(cmd)               → wrap in sandbox, spawn, return result
 *   .cleanup()              → scrub bare-repo attack files (call after EVERY tool)
 *   .refreshConfig()        → re-read permission rules after user adds an allow/deny
 *   .destroy()              → (future) teardown persistent sandbox resources
 *
 * Per-session isolation: do NOT share a CommandRunner across sessions. Detection
 * results (which backend is available) are module-level cached; everything else
 * is scoped to this instance.
 */
export class CommandRunner {
  private readonly backend:    SandboxBackend;
  private config:              SandboxConfig;
  private scrubPaths:          string[];
  private readonly degradeReason: string | undefined;

  constructor(private readonly opts: CommandRunnerOptions) {
    const detection     = detectBackend();
    this.backend        = selectBackend(detection.backend);
    this.degradeReason  = detection.degradeReason;

    const built     = buildSandboxConfig(opts.permission.getRules(), this.configCtx());
    this.config     = built.config;
    this.scrubPaths = built.scrubPaths;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Execute a shell command inside the sandbox.
   * Falls back to bare spawn if the backend is AppLayerBackend (no OS wrapping).
   */
  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    const shell     = getShell();
    const cwd       = opts.cwd ?? this.opts.workspaceRoot;
    const timeoutMs = Math.min(opts.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const { executable, args } = this.backend.wrap(command, shell, this.config);
    return spawnAndCapture(executable, args, cwd, timeoutMs, opts.signal);
  }

  /**
   * Remove any bare-repo files planted by the previous sandboxed command.
   * Must be called after EVERY tool execution — not just bash — because any
   * tool might indirectly spawn a shell.
   */
  cleanup(): void {
    scrubPlantedFiles(this.scrubPaths);
  }

  /**
   * Re-derive SandboxConfig from the current permission rules.
   * Call this immediately after PermissionEngine.addRule() / onRulePersisted.
   */
  refreshConfig(): void {
    const built     = buildSandboxConfig(this.opts.permission.getRules(), this.configCtx());
    this.config     = built.config;
    this.scrubPaths = built.scrubPaths;
  }

  /**
   * If sandboxing degraded to app-layer on a platform where OS sandboxing
   * should be available, returns a human-readable explanation.
   * Call once at session start to surface the reason to the user.
   */
  getSandboxUnavailableReason(): string | undefined {
    return this.degradeReason;
  }

  /** Name of the active backend — useful for diagnostics and tests. */
  get backendName(): string {
    return this.backend.name;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private configCtx(): ConfigContext {
    return {
      workspaceRoot:          this.opts.workspaceRoot,
      additionalWorkingDirs:  this.opts.additionalWorkingDirs,
      sessionId:              this.opts.sessionId,
    };
  }
}

// ── Backend selection ─────────────────────────────────────────────────────────

function selectBackend(kind: ReturnType<typeof detectBackend>['backend']): SandboxBackend {
  switch (kind) {
    case 'bubblewrap':   return new BubblewrapBackend();
    case 'sandbox-exec': return new SandboxExecBackend();
    default:             return new AppLayerBackend();
  }
}

// ── Shell selection ───────────────────────────────────────────────────────────

function getShell(): string {
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}

// ── Process spawner ───────────────────────────────────────────────────────────

/**
 * Spawn `executable args` and collect stdout/stderr.
 * Mirrors tool-builtin/bash.ts runShell — kept separate so sandbox has no
 * dependency on tool-builtin.
 */
function spawnAndCapture(
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

      const truncated = (stdout + stderr).length > MAX_OUTPUT_CHARS;
      if (truncated) {
        const keep = MAX_OUTPUT_CHARS / 2;
        stdout = stdout.slice(0, keep);
        stderr = stderr.slice(0, keep);
      }

      resolve({
        stdout:   stdout.trimEnd(),
        stderr:   stderr.trimEnd(),
        exitCode: code ?? -1,
        timedOut,
        truncated,
      });
    });
  });
}
