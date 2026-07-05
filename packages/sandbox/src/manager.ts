import { existsSync, rmSync } from 'node:fs';
import { spawn }               from 'node:child_process';
import { spawnProcess }        from '@ema-agent/tools';
import type { PermissionEngine } from '@ema-agent/permission';
import type { SandboxBackend, SandboxConfig, RunOptions, RunResult } from './types.js';
import { detectBackend }           from './detect.js';
import { buildSandboxConfig }      from './config-builder.js';
import { AppLayerBackend }         from './backends/app-layer.js';
import { BubblewrapBackend }       from './backends/bubblewrap.js';
import { SandboxExecBackend }      from './backends/sandbox-exec.js';
import type { ConfigContext }      from './config-builder.js';
import { probeShell }            from './shell-probe.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS     = 600_000;

// ── CommandRunner ─────────────────────────────────────────────────────────────

export interface CommandRunnerOptions {
  workspaceRoot:  string;
  sessionId?:     string;
  /** Live permission engine — rules are re-read on every refreshConfig(). */
  permission:     PermissionEngine;
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
    const cwd       = opts.cwd ?? (this.opts.workspaceRoot || process.cwd());
    const timeoutMs = Math.min(opts.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const { executable, args } = this.backend.wrap(command, shell, this.config);

    if (opts.background) {
      spawn(executable, args, { cwd, stdio: 'ignore', detached: true }).unref();
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }

    return spawnProcess(executable, args, cwd, timeoutMs, opts.signal);
  }

  /**
   * Remove any bare-repo files planted by the previous sandboxed command.
   * Must be called after EVERY tool execution — not just bash — because any
   * tool might indirectly spawn a shell.
   */
  cleanup(): void {
    for (const p of this.scrubPaths) {
      if (!existsSync(p)) continue;
      try { rmSync(p, { recursive: true }); } catch { /* ENOENT or permission error — already cleaned */ }
    }
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
      workspaceRoot: this.opts.workspaceRoot,
      sessionId:      this.opts.sessionId,
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
  const result = probeShell();
  if (!result.available) {
    throw new Error(
      '[sandbox] bash 未找到，无法执行 shell 命令。' +
      '请安装 Git for Windows(https://git-scm.com/download/win)或启用 WSL2。',
    );
  }
  return result.path;
}

