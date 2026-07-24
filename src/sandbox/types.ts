/** 沙箱内进程可以或禁止访问的文件路径。 */
export interface SandboxFilesystemConfig {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
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

/** 后端包装命令后真正要启动的程序和参数。 */
export interface WrappedCommand {
  executable: string;
  args: string[];
}

export interface SandboxBackend {
  readonly name: string;
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
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
}

/** Tool 执行层只依赖这项能力，不接触 Sandbox 的配置和后端实现。 */
export interface CommandRunnerPort {
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
