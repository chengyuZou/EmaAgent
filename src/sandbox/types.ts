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

export type BackendKind = 'bubblewrap' | 'sandbox-exec' | 'unisolated';

/**
 * 后端真正启动的 Shell 形态:
 * - native: 本机可执行文件, path 是真实文件路径(如 /bin/bash、Git bash.exe);
 * - wsl:    bash 在 WSL 虚拟机内, 命令经 wsl.exe 路由, 没有本机路径。
 */
export type ShellSpec =
  | { readonly kind: 'native'; readonly path: string }
  | { readonly kind: 'wsl' };

/** 后端包装命令后真正要启动的程序和参数。 */
export interface WrappedCommand {
  executable: string;
  args: string[];
}

/**
 * Sandbox 最终决定的启动形态: 平台后端 + 结构化 argv + 工作目录 + 净化环境。
 * Backend 产出 WrappedCommand, CommandRunner 补齐 cwd/environment,
 * ProcessRunner 只执行, 不再读取 process.env 或理解 Sandbox Policy。
 */
export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface SandboxBackend {
  readonly kind: BackendKind;
  wrap(command: string, shell: ShellSpec, config: SandboxConfig): WrappedCommand;
}

/** 为一个 Session 冻结的命令执行能力；Sandbox 不从 Permission 规则反推。 */
export interface SandboxCapability {
  /** 必填;空串直接拒绝,不允许回退到宿主进程工作目录。 */
  workspaceRoot: string;
  /** 绝对路径;workspaceRoot 之外的附加可写根,构造时统一规范化,不含空项。 */
  writablePaths: readonly string[];
  /** 绝对路径;同时禁止读取与写入(protected 表达不出这个强度,故名 forbidden)。 */
  forbiddenPaths: readonly string[];
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
  /** 进程自身退出码;被信号杀死或预检取消时为 -1。spawn 启动失败不走这里——Promise 直接 reject。 */
  exitCode: number;
  timedOut: boolean;
  /** 仅表示内存中累计的 stdout/stderr 文本被截断,不代表 onOutput 原始流被截。 */
  truncated: boolean;
  /** 与 timedOut 互斥:超时优先记 timedOut,不计 aborted。 */
  aborted: boolean;
}

/** 已启动进程的稳定句柄；stop 终止整棵进程树，completion 只结算一次。 */
export interface CommandProcessHandle {
  readonly completion: Promise<CommandRunResult>;
  stop(): void;
}


