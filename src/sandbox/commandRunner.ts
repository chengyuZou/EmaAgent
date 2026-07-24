// 使用一份冻结的 Sandbox 能力快照包装并执行当前 Session 的 Shell 命令。

import { existsSync, rmSync } from 'node:fs';
import { buildSandboxConfig } from './config-builder.js';
import { detectBackend } from './detect.js';
import { AppLayerBackend } from './backends/app-layer.js';
import { BubblewrapBackend } from './backends/bubblewrap.js';
import { SandboxExecBackend } from './backends/sandbox-exec.js';
import { runProcess } from './processRunner.js';
import { probeShell } from './shell-probe.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandRunnerPort,
  SandboxBackend,
  SandboxCapability,
  SandboxConfig,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export class CommandRunner implements CommandRunnerPort {
  private readonly capability: SandboxCapability;
  private readonly backend: SandboxBackend;
  private readonly config: SandboxConfig;
  private readonly scrubPaths: readonly string[];
  private readonly degradeReason: string | undefined;

  constructor(capability: SandboxCapability) {
    if (capability.workspaceRoot.trim() === '') {
      throw new Error('CommandRunner 需要明确的 workspaceRoot，禁止回退到进程工作目录。');
    }
    this.capability = Object.freeze({
      workspaceRoot: capability.workspaceRoot,
      writablePaths: Object.freeze([...capability.writablePaths]),
      protectedPaths: Object.freeze([...capability.protectedPaths]),
      networkAccess: capability.networkAccess,
    });

    const detection = detectBackend();
    this.backend = selectBackend(detection.backend);
    this.degradeReason = detection.degradeReason;

    const built = buildSandboxConfig(this.capability);
    this.config = built.config;
    this.scrubPaths = built.scrubPaths;
  }

  async run(command: string, options: CommandRunOptions = {}): Promise<CommandRunResult> {
    const cwd = options.cwd ?? this.capability.workspaceRoot;
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const shell = resolveShell();
    const wrapped = this.backend.wrap(command, shell, this.config);

    return runProcess(
      wrapped.executable,
      wrapped.args,
      cwd,
      timeoutMs,
      options.signal,
    );
  }

  cleanup(): void {
    for (const targetPath of this.scrubPaths) {
      if (!existsSync(targetPath)) continue;
      try {
        rmSync(targetPath, { recursive: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[sandbox] cleanup 失败 (${code ?? 'unknown'}): ${targetPath}`);
        }
      }
    }
  }

  getSandboxUnavailableReason(): string | undefined {
    return this.degradeReason;
  }

  get backendName(): string {
    return this.backend.name;
  }
}

function selectBackend(kind: ReturnType<typeof detectBackend>['backend']): SandboxBackend {
  switch (kind) {
    case 'bubblewrap':
      return new BubblewrapBackend();
    case 'sandbox-exec':
      return new SandboxExecBackend();
    default:
      return new AppLayerBackend();
  }
}

function resolveShell(): string {
  const result = probeShell();
  if (!result.available) {
    throw new Error(
      '[sandbox] Bash 未找到，无法执行 Shell 命令。'
      + '请安装 Git for Windows，或在 Windows 上启用 WSL2。',
    );
  }
  return result.path;
}
