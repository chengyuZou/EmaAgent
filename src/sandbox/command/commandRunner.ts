import { buildSandboxConfig, resolveCommandCwd } from './commandPaths.js';
import { detectBackend } from '../backends/detectBackend.js';
import { UnisolatedBackend } from '../backends/unisolated.js';
import { BubblewrapBackend } from '../backends/bubblewrap.js';
import { SandboxExecBackend } from '../backends/sandboxExec.js';
import { startProcess } from '../process/processRunner.js';
import { buildProcessEnvironment } from '../process/processEnvironment.js';
import type {
  CommandRunOptions,
  CommandProcessHandle,
  SandboxBackend,
  SandboxCapability,
  SandboxConfig,
  ShellSpec,
} from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

/** 调用方先完成 Bash 探测, 再提供本次 Turn 的路径和网络设置. */
export class CommandRunner {
  private readonly capability: SandboxCapability;
  private readonly backend: SandboxBackend;
  private readonly config: SandboxConfig;

  constructor(capability: SandboxCapability, private readonly shell: ShellSpec) {
    if (capability.cwd.trim() === '') {
      throw new Error('CommandRunner 需要明确的 cwd, 禁止回退到进程工作目录.');
    }
    this.capability = Object.freeze({
      cwd: capability.cwd,
      writablePaths: Object.freeze([...capability.writablePaths]),
      forbiddenPaths: Object.freeze([...capability.forbiddenPaths]),
      networkAccess: capability.networkAccess,
    });
    this.backend = selectBackend(detectBackend().backend);
    this.config = buildSandboxConfig(this.capability);
  }

  start(command: string, options: CommandRunOptions = {}): CommandProcessHandle {
    const cwd = resolveCommandCwd(options.cwd, this.capability);
    const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const wrapped = this.backend.wrap(command, this.shell, this.config);
    return startProcess(
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
