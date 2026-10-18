export interface SandboxFilesystemConfig {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
}

export interface SandboxNetworkConfig {
  /** none 请求后端断网, full 不限制网络. unisolated 后端不实施这项限制. */
  access: SandboxNetwork;
}

export type SandboxNetwork = 'none' | 'full';

export interface SandboxConfig {
  filesystem: SandboxFilesystemConfig;
  network: SandboxNetworkConfig;
}

export type BackendKind = 'bubblewrap' | 'sandbox-exec' | 'unisolated';

/**
 * 后端真正启动的 Shell 形态:
 * - native: 本机可执行文件, path 是真实文件路径(如 /bin/bash, Git bash.exe);
 * - wsl:    bash 在 WSL 虚拟机内, 命令经 wsl.exe 路由, 没有本机路径.
 */
export type ShellSpec =
  | { readonly kind: 'native'; readonly path: string }
  | { readonly kind: 'wsl' };

/** 后端包装命令后真正要启动的程序和参数. */
export interface WrappedCommand {
  executable: string;
  args: string[];
}

/**
 * 已准备好的进程启动参数. 沙箱命令由 CommandRunner 包装并净化环境;
 * 本机 PowerShell 由内置工具准备参数. 进程执行层不决定权限或隔离策略.
 */
export interface ProcessCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface SandboxBackend {
  wrap(command: string, shell: ShellSpec, config: SandboxConfig): WrappedCommand;
}

/** Server 在 Turn 准备时提供的执行范围, CommandRunner 构造后保持不变. */
export interface SandboxCapability {
  /** 必填; 空串直接拒绝, 不允许回退到宿主进程工作目录. */
  cwd: string;
  /** 完整可写根列表, 通常包含工作区与临时目录; 不会自动加入 cwd. */
  writablePaths: readonly string[];
  /** 后端配置同时禁止读取和写入的绝对路径. */
  forbiddenPaths: readonly string[];
  networkAccess: SandboxNetwork;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 原始输出保存入口, 不受最终文本长度限制. 抛错会停止命令并使 completion 拒绝. */
  onOutput?: (chunk: CommandOutputChunk) => void;
}

export interface CommandOutputChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly data: Uint8Array;
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  /** 进程退出码, 无退出码或启动前已取消时为 -1. 启动失败则 completion 直接拒绝. */
  exitCode: number;
  timedOut: boolean;
  /** 仅表示内存中累计的 stdout/stderr 文本被截断,不代表 onOutput 原始流被截. */
  truncated: boolean;
  /** 与 timedOut 互斥:超时优先记 timedOut,不计 aborted. */
  aborted: boolean;
}

/** stop 请求终止进程树, 已结束时不再发送请求. completion 等待子进程结束或启动失败. */
export interface CommandProcessHandle {
  readonly completion: Promise<CommandRunResult>;
  stop(): void;
}

/** 后台调度只需要启动句柄, 不依赖具体 Shell 的权限与包装方式. */
export interface CommandStarter {
  start(command: string, options: CommandRunOptions & { cwd: string; timeoutMs: number }): CommandProcessHandle;
}
