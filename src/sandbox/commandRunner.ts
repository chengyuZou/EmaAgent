// 使用一份冻结的 Sandbox 能力快照包装并执行当前 Session 的 Shell 命令。

import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildSandboxConfig } from './config-builder.js';
import { detectBackend } from './detect.js';
import { AppLayerBackend } from './backends/app-layer.js';
import { BubblewrapBackend } from './backends/bubblewrap.js';
import { SandboxExecBackend } from './backends/sandbox-exec.js';
import { runProcess } from './processRunner.js';
import { buildProcessEnvironment } from './processEnvironment.js';
import { resolveCommandCwd } from './resolveCommandCwd.js';
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

/** bare-repo 完整签名: 三者同时存在才构成"工作区变成了 Git 仓库"。 */
const BARE_SIGNATURE = ['HEAD', 'objects', 'refs'] as const;
/** 攻击真正利用的两个落点: Git 会读取并执行/采信它们。 */
const BARE_EXPLOIT_FILES = ['hooks', 'config'] as const;

export class CommandRunner implements CommandRunnerPort {
  private readonly capability: SandboxCapability;
  private readonly backend: SandboxBackend;
  private readonly config: SandboxConfig;
  private readonly bareRepoExistedAtStart: boolean;
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

    this.config = buildSandboxConfig(this.capability);
    this.bareRepoExistedAtStart = hasBareRepoSignature(capability.workspaceRoot);
  }

  async run(command: string, options: CommandRunOptions = {}): Promise<CommandRunResult> {
    const cwd = resolveCommandCwd(options.cwd, this.capability);
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const shell = resolveShell();
    const wrapped = this.backend.wrap(command, shell, this.config);

    try {
      return await runProcess(
        {
          backend: this.backend.name,
          executable: wrapped.executable,
          args: wrapped.args,
          cwd,
          environment: buildProcessEnvironment(),
        },
        timeoutMs,
        options.signal,
      );
    } finally {
      this.cleanup();
    }
  }

  /**
   * bare-repo 防御: 只有当"构造时不存在、命令执行后出现了完整 bare 签名"
   * 才拆除 hooks/config 两个真实攻击落点。普通项目新建的 config 文件、
   * hooks 目录不会被误伤; 本就位于仓库根的工作区不受影响。
   */
  cleanup(): void {
    if (this.bareRepoExistedAtStart) return;
    const root = this.capability.workspaceRoot;
    if (!hasBareRepoSignature(root)) return;
    for (const fileName of BARE_EXPLOIT_FILES) {
      const target = path.join(root, fileName);
      if (!existsSync(target)) continue;
      try {
        rmSync(target, { recursive: true, force: true });
        console.warn(`[sandbox] 已拆除可疑 bare-repo 落点: ${target}`);
      } catch (error) {
        console.warn(`[sandbox] bare-repo 落点清理失败: ${target}`, error);
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

/** 工作区根是否同时存在 HEAD + objects + refs(bare-repo 签名)。 */
function hasBareRepoSignature(root: string): boolean {
  return BARE_SIGNATURE.every((fileName) => {
    try {
      statSync(path.join(root, fileName));
      return true;
    } catch {
      return false;
    }
  });
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
