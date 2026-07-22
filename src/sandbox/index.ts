// 这是 Sandbox 包的统一出口，外部代码从这里创建命令运行器并查看沙箱状态。

export { CommandRunner }             from './manager.js';
export type { CommandRunnerOptions } from './manager.js';

export { probeShell, installGitViaWinget } from './shell-probe.js';
export type { ShellProbeResult, GitInstallResult } from './shell-probe.js';

export { detectBackend, resetDetectCache } from './detect.js';
export type { DetectResult, BackendKind }  from './detect.js';

export { getPlatform, resetPlatformCache } from './platform.js';
export type { SandboxPlatform }            from './platform.js';

export { buildSandboxConfig }              from './config-builder.js';
export type { ConfigContext, BuildResult } from './config-builder.js';

export type {
  SandboxConfig,
  SandboxFilesystemConfig,
  SandboxNetworkConfig,
  SandboxBackend,
  WrappedCommand,
  RunOptions,
  RunResult,
  SandboxStatusWire,
} from './types.js';
