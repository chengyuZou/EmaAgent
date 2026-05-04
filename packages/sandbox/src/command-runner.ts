import { spawn } from "node:child_process"

import { EmaError } from "@ema-agent/core-types"

import { resolveWorkspacePath } from "./scope.js"
import type { CommandRunInput, CommandRunResult, WorkspaceScope } from "./types.js"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 256_000

/**
 * 工作区命令执行器。
 *
 * 默认不走 shell，只执行 argv 形式命令；这样 Windows / Linux / macOS 下都能避免
 * 一层 shell 解析带来的注入风险。命令是否允许由 WorkspaceScope.allowedCommands 控制。
 */
export class CommandRunner {
  constructor(private readonly scope: WorkspaceScope) {}

  run(input: CommandRunInput): Promise<CommandRunResult> {
    assertCommandAllowed(this.scope, input.command)

    const cwd = resolveWorkspacePath(this.scope, input.cwd ?? ".")
    const args = [...(input.args ?? [])]
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const startedAt = Date.now()

    return new Promise((resolvePromise, reject) => {
      const child = spawn(input.command, args, {
        cwd,
        shell: false,
        env: input.env ? { ...process.env, ...input.env } : process.env,
        windowsHide: true,
      })

      let stdout = ""
      let stderr = ""
      let timedOut = false

      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk.toString("utf8"), maxOutputBytes)
      })

      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk.toString("utf8"), maxOutputBytes)
      })

      child.on("error", (error) => {
        clearTimeout(timeout)
        reject(new EmaError("tool_failed", error.message, false, { command: input.command }))
      })

      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout)
        resolvePromise({
          command: input.command,
          args,
          cwd,
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
        })
      })
    })
  }
}

function assertCommandAllowed(scope: WorkspaceScope, command: string): void {
  if (!scope.allowedCommands.includes(command)) {
    throw new EmaError("sandbox_denied", `命令不在白名单中：${command}`, false, {
      allowedCommands: scope.allowedCommands,
    })
  }
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const combined = `${current}${next}`
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined
  }
  return combined.slice(-maxBytes)
}
