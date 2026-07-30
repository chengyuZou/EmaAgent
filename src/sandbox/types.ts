/** 沙箱内进程可以或禁止访问的文件路径。 */
export interface SandboxFilesystemConfig {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
}

/** 沙箱内进程的网络访问策略。 */
export interface SandboxNetworkConfig {
  /** V1 只支持完全断网或全网访问，不声称支持域名白名单。 */
  access: 'none' | 'full';
}

export interface SandboxConfig {
  filesystem: SandboxFilesystemConfig;
  network: SandboxNetworkConfig;
}

export type BackendKind = 'bubblewrap' | 'sandbox-exec' | 'app-layer';

/** 后端包装命令后真正要启动的程序和参数。 */
export interface WrappedCommand {
  executable: string;
  args: string[];
}

/**
 * Sandbox 最终决定的启动形态: 平台后端 + 结构化 argv + 工作目录 + 净化环境。
 * Backend 产出 WrappedCommand, CommandRunner 补齐 backend/cwd/environment,
 * ProcessRunner 只执行, 不再读取 process.env 或理解 Sandbox Policy。
 */
export interface SandboxCommand {
  readonly backend: BackendKind;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface SandboxBackend {
  readonly name: BackendKind;
  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand;
}

/** Core 为一个 Session 冻结的命令执行能力；Sandbox 不从 Permission 规则反推。 */
export interface SandboxCapability {
  workspaceRoot: string;
  writablePaths: readonly string[];
  protectedPaths: readonly string[];
  networkAccess: 'none' | 'full';
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 原始输出增量只供受控日志存储使用；最终结果仍保持有界。 */
  onOutput?: (chunk: CommandOutputChunk) => void;
}

export interface CommandOutputChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly data: Uint8Array;
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
}

/** 已启动进程的稳定句柄；stop 终止整棵进程树，completion 只结算一次。 */
export interface CommandProcessHandle {
  readonly completion: Promise<CommandRunResult>;
  stop(): void;
}

/** Tool 执行层只依赖这项能力，不接触 Sandbox 的配置和后端实现。 */
export interface CommandRunnerPort {
  start(command: string, options?: CommandRunOptions): CommandProcessHandle;
  run(command: string, options?: CommandRunOptions): Promise<CommandRunResult>;
  cleanup(): void;
}

/** 当前机器对 Shell 与本地 MCP 进程实际提供的隔离能力。 */
export interface SandboxStatusWire {
  readonly backend: 'bubblewrap' | 'sandbox-exec' | 'app-layer';
  readonly isolation: 'os' | 'application-only';
  readonly shellExecution: 'isolated' | 'disabled' | 'unsafe-override';
  readonly sandboxNetwork: 'none' | 'full';
  readonly localMcpStdio: 'isolated' | 'disabled' | 'unsafe-override';
  readonly warning?: string;
}
