// Sandbox 的公共出口:命令运行器、平台/后端探测与 Bash 可用性。

export { CommandRunner } from './commandRunner.js';

export { probeBash, installGitViaWinget } from './bashProbe.js';
export type { BashProbeResult, GitInstallResult } from './bashProbe.js';

export { detectBackend } from './detectBackend.js';
export type { DetectResult, BackendKind }  from './detectBackend.js';

export type {
  SandboxConfig,
  SandboxCapability,
  SandboxFilesystemConfig,
  SandboxNetworkConfig,
  SandboxBackend,
  WrappedCommand,
  SandboxCommand,
  CommandRunOptions,
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunResult,
  CommandRunnerPort,
} from './types.js';
