// 使用一份冻结的 Sandbox 能力快照包装并执行当前 Session 的 Shell 命令。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildSandboxConfig } from './buildSandboxConfig.js';
import { detectBackend } from './detectBackend.js';
import { UnisolatedBackend } from './backends/unisolated.js';
import { BubblewrapBackend } from './backends/bubblewrap.js';
import { SandboxExecBackend } from './backends/sandbox-exec.js';
import { startProcess } from './processRunner.js';
import { buildProcessEnvironment } from './processEnvironment.js';
import { resolveCommandCwd } from './resolveCommandCwd.js';
import { probeBash, probeBashSettled } from './bashProbe.js';
import { BARE_REPO_EXPLOIT_FILES, hasBareRepoSignature } from './bareRepoSurface.js';
import type {
  CommandRunOptions,
  CommandProcessHandle,
  CommandRunResult,
  CommandRunnerPort,
  SandboxBackend,
  SandboxCapability,
  SandboxConfig,
  ShellSpec,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

export class CommandRunner implements CommandRunnerPort {
  private readonly capability: SandboxCapability;
  private readonly backend: SandboxBackend;
  private readonly config: SandboxConfig;
  private readonly bareRepoExistedAtStart: boolean;
  /** 构造时已存在的 hooks/config 路径: 归属用户, 永不警告永不触碰。 */
  private readonly exploitPathsExistedAtStart: ReadonlySet<string>;

  constructor(capability: SandboxCapability) {
    if (capability.workspaceRoot.trim() === '') {
      throw new Error('CommandRunner 需要明确的 workspaceRoot，禁止回退到进程工作目录。');
    }
    this.capability = Object.freeze({
      workspaceRoot: capability.workspaceRoot,
      writablePaths: Object.freeze([...capability.writablePaths]),
      forbiddenPaths: Object.freeze([...capability.forbiddenPaths]),
      networkAccess: capability.networkAccess,
    });

    const detection = detectBackend();
    this.backend = selectBackend(detection.backend);

    // 兜底预热 shell 探测(正常由 Server 启动期提前发起):
    // 让首个 start() 的 probeBashSettled 尽量命中已结算缓存。
    void probeBash();

    this.config = buildSandboxConfig(this.capability);
    this.bareRepoExistedAtStart = hasBareRepoSignature(capability.workspaceRoot);
    this.exploitPathsExistedAtStart = new Set(
      BARE_REPO_EXPLOIT_FILES.filter((fileName) =>
        existsSync(path.join(capability.workspaceRoot, fileName)),
      ),
    );
  }

  start(command: string, options: CommandRunOptions = {}): CommandProcessHandle {
    const cwd = resolveCommandCwd(options.cwd, this.capability);
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const shell = resolveShell();
    const wrapped = this.backend.wrap(command, shell, this.config);
    const handle = startProcess(
      {
        executable: wrapped.executable,
        args: wrapped.args,
        cwd,
        environment: buildProcessEnvironment(),
      },
      timeoutMs,
      options.signal,
      options.onOutput,
    );
    void handle.completion.then(
      () => this.cleanup(),
      () => this.cleanup(),
    );
    return handle;
  }

  async run(command: string, options: CommandRunOptions = {}): Promise<CommandRunResult> {
    return this.start(command, options).completion;
  }

  /**
   * bare-repo 防御: V1 不删除任何路径。
   * git init/git clone --bare 与 bare 攻击创建的文件形态完全相同,
   * 仅凭"执行后出现"无法区分, 误删用户数据的代价比残留更糟(P1 评审)。
   * 这里只做归属记录与警告; 真正的隔离留给后续受控 Git 环境
   * (core.hooksPath / GIT_CONFIG 隔离), 不靠删除。
   */
  private cleanup(): void {
    if (this.bareRepoExistedAtStart) return;
    const root = this.capability.workspaceRoot;
    if (!hasBareRepoSignature(root)) return;
    const newExploits = BARE_REPO_EXPLOIT_FILES.filter(
      (fileName) =>
        !this.exploitPathsExistedAtStart.has(fileName) && existsSync(path.join(root, fileName)),
    );
    if (newExploits.length === 0) return;
    console.warn(
      `[sandbox] 命令执行后工作区出现 bare-repo 签名, `
      + `${newExploits.join(' 与 ')} 会被后续 git 命令信任, 请人工确认来源: ${root}`,
    );
  }
}

function selectBackend(kind: ReturnType<typeof detectBackend>['backend']): SandboxBackend {
  switch (kind) {
    case 'bubblewrap':
      return new BubblewrapBackend();
    case 'sandbox-exec':
      return new SandboxExecBackend();
    default:
      return new UnisolatedBackend();
  }
}

/**
 * 把已结算的 bash 探测结果翻译成后端启动形态。
 * start() 是同步路径(后台进程调度立即持有句柄), 不能 await 探测——
 * 冷窗口(探测尚未结算)与未找到 bash 都如实抛错, 不假装能执行。
 */
function resolveShell(): ShellSpec {
  const probe = probeBashSettled();
  if (probe === undefined) {
    throw new Error('[sandbox] Shell 探测尚未完成, 请稍后重试该命令。');
  }
  if (!probe.available) {
    // 只有 Windows 会走到 unavailable(Linux/macOS 探测恒 available)。
    throw new Error(
      '[sandbox] 未找到可用的 Bash。请安装 Git for Windows, 或启用 WSL2 后重试。',
    );
  }
  return probe.source === 'wsl' ? { kind: 'wsl' } : { kind: 'native', path: probe.path };
}
