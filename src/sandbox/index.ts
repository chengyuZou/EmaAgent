export { CommandRunner } from './command/commandRunner.js';
export { startProcess } from './process/processRunner.js';

export { probeBash } from './discovery/bashProbe.js';
export type { BashProbeResult } from './discovery/bashProbe.js';

export { detectTerminalShells } from './discovery/terminalShells.js';
export type { TerminalShellInfo, TerminalShellKind } from './discovery/terminalShells.js';

export { sandboxNetworkSetting } from './settings.js';

export { detectBackend } from './backends/detectBackend.js';
export type { DetectResult } from './backends/detectBackend.js';

export type {
  SandboxCapability,
  SandboxNetwork,
  BackendKind,
  ShellSpec,
  ProcessCommand,
  CommandStarter,
  CommandRunOptions,
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunResult,
} from './types.js';
