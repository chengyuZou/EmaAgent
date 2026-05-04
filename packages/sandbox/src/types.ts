export interface WorkspaceScope {
  /** 工作区根目录，必须是绝对路径。 */
  rootDir: string
  /** 是否允许写文件。 */
  allowWrite: boolean
  /** 是否允许工具发起网络访问；命令执行层只记录策略，不做网络沙箱。 */
  allowNetwork: boolean
  /** 可执行命令白名单。为空表示禁止 runCommand。 */
  allowedCommands: readonly string[]
}

export interface CommandRunInput {
  command: string
  args?: readonly string[]
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  env?: Record<string, string>
}

export interface CommandRunResult {
  command: string
  args: string[]
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}
