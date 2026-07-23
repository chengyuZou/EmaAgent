/** 沙箱内进程可以或禁止访问的文件路径。 */
export interface SandboxFilesystemConfig {
  allowWrite: string[]
  denyWrite: string[]
  denyRead: string[]
  allowRead: string[]
}

/** 沙箱内进程的网络访问策略。 */
export interface SandboxNetworkConfig {
  /** V1 只支持完全断网或全网访问，不声称支持域名白名单。 */
  access: 'none' | 'full'
}

export interface SandboxConfig {
  filesystem: SandboxFilesystemConfig
  network:    SandboxNetworkConfig
}

// TODO WSL_BASH_SENTINEL 是运行时常量（shell-probe 产出、app-layer/bubblewrap 消费），
//  放 types.ts 是务实（双方都依赖 types.ts，避免额外 import），但严格说 types.ts 该只放类型。
//  待 sandbox 批次整理时考虑迁到独立常量文件或 shell-probe.ts。
/** Windows 没有原生 bash，但可以调用 WSL bash 时使用的内部标记。 */
export const WSL_BASH_SENTINEL = 'wsl:bash'

/** 后端包装命令后真正要启动的程序和参数。 */
export interface WrappedCommand {
  executable: string
  args:       string[]
}

// TODO isAvailable() 在三个 backend 都是摆设（真实检测在 detect.ts）。待 sandbox
//  批次简化接口时从 SandboxBackend 删除该方法。
export interface SandboxBackend {
  readonly name: string
  isAvailable(): boolean
  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand
}

// TODO RunOptions/RunResult 与 src/tools/types.ts 的同名类型重复定义且已漂移
//  （sandbox 这份 RunResult 缺 aborted 字段，tools 那份有）。这是 tools↛sandbox
//  循环依赖防线导致的重复（tools 定义接口，sandbox 实现，各自维护类型）。
//  待统一到零业务依赖的共享位置（如 src/ids 或 src/tools/contracts），两包都 import。
export interface RunOptions {
  cwd?:        string
  timeout?:    number
  signal?:     AbortSignal
  background?: boolean
}

export interface RunResult {
  stdout:    string
  stderr:    string
  exitCode:  number
  timedOut:  boolean
  truncated: boolean
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