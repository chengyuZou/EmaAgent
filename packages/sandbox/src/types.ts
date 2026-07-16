// 这里放 Sandbox 使用的配置、运行参数和后端接口。

/** 沙箱内进程可以或禁止访问的文件路径。 */
export interface SandboxFilesystemConfig {
  allowWrite: string[]
  denyWrite: string[]
  denyRead: string[]
  allowRead: string[]
}

/** 沙箱内进程可以或禁止访问的网络域名。 */
export interface SandboxNetworkConfig {
  allowedDomains: string[]
  deniedDomains: string[]
}

export interface SandboxConfig {
  filesystem: SandboxFilesystemConfig
  network:    SandboxNetworkConfig
}

/** Windows 没有原生 bash，但可以调用 WSL bash 时使用的内部标记。 */
export const WSL_BASH_SENTINEL = 'wsl:bash'

/** 后端包装命令后真正要启动的程序和参数。 */
export interface WrappedCommand {
  executable: string
  args:       string[]
}

export interface SandboxBackend {
  readonly name: string
  isAvailable(): boolean
  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand
}

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
