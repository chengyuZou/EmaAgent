export { CommandRunner }             from './manager.js';
export type { CommandRunnerOptions } from './manager.js';

export { detectBackend, resetDetectCache } from './detect.js';
export type { DetectResult, BackendKind }  from './detect.js';

export { getPlatform, resetPlatformCache } from './platform.js';
export type { SandboxPlatform }            from './platform.js';

export { buildSandboxConfig, scrubPlantedFiles } from './config-builder.js';
export type { ConfigContext, BuildResult }        from './config-builder.js';

export type {
  SandboxConfig,
  SandboxFilesystemConfig,
  SandboxNetworkConfig,
  SandboxBackend,
  WrappedCommand,
  RunOptions,
  RunResult,
} from './types.js';
