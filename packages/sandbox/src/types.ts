// ── Sandbox config (OS-agnostic) ─────────────────────────────────────────────

export interface SandboxFilesystemConfig {
  /** Paths the sandboxed process may write to. */
  allowWrite: string[]
  /** Paths the sandboxed process must not write to (overrides allowWrite). */
  denyWrite: string[]
  /** Paths the sandboxed process must not read. */
  denyRead: string[]
  /** Extra paths explicitly allowed for read (informational; most backends allow-all-read by default). */
  allowRead: string[]
}

export interface SandboxNetworkConfig {
  /** Domains the process may reach. Empty = deny all outbound (if backend supports it). */
  allowedDomains: string[]
  /** Domains explicitly denied (for backends with domain-level filtering). */
  deniedDomains: string[]
}

export interface SandboxConfig {
  filesystem: SandboxFilesystemConfig
  network:    SandboxNetworkConfig
}

// ── Backend interface ─────────────────────────────────────────────────────────

/**
 * What a backend returns when asked to wrap a command.
 * The runner spawns `executable` with `args` directly — no extra shell layer.
 */
export interface WrappedCommand {
  executable: string
  args:       string[]
}

export interface SandboxBackend {
  readonly name: string
  /** Returns true if the required OS tools are installed and usable. */
  isAvailable(): boolean
  /** Wrap a shell command so it runs inside the sandbox. */
  wrap(command: string, shell: string, config: SandboxConfig): WrappedCommand
}

// ── Run primitives ────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Override working directory (defaults to workspaceRoot). */
  cwd?:        string
  /** Milliseconds before SIGTERM + SIGKILL. */
  timeout?:    number
  /** AbortSignal for turn cancellation. */
  signal?:     AbortSignal
  /** Fire-and-forget: spawn detached through the sandbox backend, return immediately. */
  background?: boolean
}

export interface RunResult {
  stdout:   string
  stderr:   string
  exitCode: number
  timedOut: boolean
  truncated: boolean
}
