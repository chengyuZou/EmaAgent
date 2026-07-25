// 这是 Sandbox 包的统一出口，外部代码从这里创建命令运行器并查看沙箱状态。

export { CommandRunner } from './commandRunner.js';

export { probeBash, installGitViaWinget, resetBashProbeCache } from './bashProbe.js';
export type { BashProbeResult, GitInstallResult } from './bashProbe.js';

export { detectBackend, resetDetectCache } from './detect.js';
export type { DetectResult, BackendKind }  from './detect.js';

export { getPlatform, resetPlatformCache } from './platform.js';
export type { SandboxPlatform }            from './platform.js';

export { buildSandboxConfig }              from './config-builder.js';

export { buildProcessEnvironment }          from './processEnvironment.js';

export type {
  SandboxConfig,
  SandboxCapability,
  SandboxFilesystemConfig,
  SandboxNetworkConfig,
  SandboxBackend,
  WrappedCommand,
  SandboxCommand,
  CommandRunOptions,
  CommandRunResult,
  CommandRunnerPort,
  SandboxStatusWire,
} from './types.js';
