import { randomUUID, createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"

import { EmaError } from "@ema-agent/core-types"
import { CommandRunner, assertWriteAllowed, resolveWorkspacePath } from "@ema-agent/sandbox"
import type { WorkspaceScope } from "@ema-agent/sandbox"

import type { ToolExecutionContext, ToolExecutionResult } from "./types.js"

export interface ToolExecutorOptions {
  scope: WorkspaceScope
  /** 单次 read_file 的默认最大读取字节数。 */
  defaultMaxReadBytes?: number
  /** search_text 递归搜索时最多读取多少个文件。 */
  maxSearchFiles?: number
}

interface ReadFileArgs {
  path: string
  maxBytes?: number
}

interface WriteFileArgs {
  path: string
  content: string
  expectedSha256?: string
}

interface ListDirArgs {
  path: string
  recursive?: boolean
}

interface SearchTextArgs {
  query: string
  path?: string
  regex?: boolean
}

interface RunCommandArgs {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

interface RunPythonArgs {
  code: string
  cwd?: string
  timeoutMs?: number
  pythonCommand?: string
  pythonArgs?: string[]
}

/**
 * 内置工具执行器。
 *
 * 这层是模型工具调用与沙箱能力之间的桥：
 * - 参数在这里做最小校验。
 * - 文件路径交给 sandbox 解析，确保不越过 workspace。
 * - 命令统一走 CommandRunner，默认不经过 shell。
 */
export class BuiltinToolExecutor {
  private readonly commandRunner: CommandRunner

  constructor(private readonly options: ToolExecutorOptions) {
    this.commandRunner = new CommandRunner(options.scope)
  }

  async execute(toolName: string, args: Record<string, unknown>, context: ToolExecutionContext = {}): Promise<ToolExecutionResult> {
    const startedAt = context.startedAt ?? Date.now()

    try {
      const data = await this.dispatch(toolName, args)
      return {
        toolName,
        success: true,
        resultStr: formatToolData(data),
        data,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        toolName,
        success: false,
        resultStr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      }
    }
  }

  private async dispatch(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "read_file":
        return this.readFile(asReadFileArgs(args))
      case "write_file":
        return this.writeFile(asWriteFileArgs(args))
      case "list_dir":
        return this.listDir(asListDirArgs(args))
      case "search_text":
        return this.searchText(asSearchTextArgs(args))
      case "run_command":
        return this.runCommand(asRunCommandArgs(args))
      case "run_python":
        return this.runPython(asRunPythonArgs(args))
      default:
        throw new EmaError("tool_failed", `未实现的内置工具：${toolName}`, false)
    }
  }

  private async readFile(args: ReadFileArgs): Promise<{ path: string; content: string; sha256: string; truncated: boolean }> {
    const fullPath = resolveWorkspacePath(this.options.scope, args.path)
    const maxBytes = args.maxBytes ?? this.options.defaultMaxReadBytes ?? 256_000
    const buffer = await readFile(fullPath)
    const truncated = buffer.byteLength > maxBytes
    const content = buffer.subarray(0, maxBytes).toString("utf8")

    return {
      path: toWorkspacePath(this.options.scope, fullPath),
      content,
      sha256: sha256(buffer),
      truncated,
    }
  }

  private async writeFile(args: WriteFileArgs): Promise<{ path: string; sha256: string; bytes: number }> {
    assertWriteAllowed(this.options.scope)
    const fullPath = resolveWorkspacePath(this.options.scope, args.path)

    if (args.expectedSha256) {
      const current = await readOptionalFile(fullPath)
      const currentHash = current ? sha256(current) : undefined
      if (currentHash !== args.expectedSha256) {
        throw new EmaError("sandbox_denied", "文件内容已经变化，拒绝覆盖。", false, {
          expectedSha256: args.expectedSha256,
          currentHash,
        })
      }
    }

    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, args.content, "utf8")
    const buffer = Buffer.from(args.content, "utf8")

    return {
      path: toWorkspacePath(this.options.scope, fullPath),
      sha256: sha256(buffer),
      bytes: buffer.byteLength,
    }
  }

  private async listDir(args: ListDirArgs): Promise<{ items: Array<{ path: string; type: "file" | "dir"; size?: number }> }> {
    const root = resolveWorkspacePath(this.options.scope, args.path)
    const items = await listDirectory(this.options.scope, root, Boolean(args.recursive))
    return { items }
  }

  private async searchText(args: SearchTextArgs): Promise<{ matches: Array<{ path: string; line: number; text: string }> }> {
    const root = resolveWorkspacePath(this.options.scope, args.path ?? ".")
    const matcher = createMatcher(args.query, Boolean(args.regex))
    const files = await collectFiles(this.options.scope, root, this.options.maxSearchFiles ?? 500)
    const matches: Array<{ path: string; line: number; text: string }> = []

    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => undefined)
      if (!content) {
        continue
      }

      const lines = content.split(/\r?\n/)
      lines.forEach((line, index) => {
        if (matcher(line)) {
          matches.push({
            path: toWorkspacePath(this.options.scope, file),
            line: index + 1,
            text: line,
          })
        }
      })
    }

    return { matches }
  }

  private async runCommand(args: RunCommandArgs): Promise<unknown> {
    return this.commandRunner.run({
      command: args.command,
      args: args.args,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    })
  }

  private async runPython(args: RunPythonArgs): Promise<unknown> {
    assertWriteAllowed(this.options.scope)
    const cwd = resolveWorkspacePath(this.options.scope, args.cwd ?? ".")
    const tempDir = resolveWorkspacePath(this.options.scope, ".ema-agent/tmp")
    await mkdir(tempDir, { recursive: true })

    const scriptPath = join(tempDir, `tool-${randomUUID()}.py`)
    await writeFile(scriptPath, args.code, "utf8")

    try {
      const pythonCommand = args.pythonCommand ?? "python"
      const pythonArgs = args.pythonArgs?.length
        ? [...args.pythonArgs, scriptPath]
        : [scriptPath]

      return await this.commandRunner.run({
        command: pythonCommand,
        args: pythonArgs,
        cwd,
        timeoutMs: args.timeoutMs,
      })
    } finally {
      await rm(scriptPath, { force: true }).catch(() => undefined)
    }
  }
}

function asReadFileArgs(args: Record<string, unknown>): ReadFileArgs {
  return {
    path: requireString(args.path, "path"),
    maxBytes: optionalNumber(args.maxBytes),
  }
}

function asWriteFileArgs(args: Record<string, unknown>): WriteFileArgs {
  return {
    path: requireString(args.path, "path"),
    content: requireString(args.content, "content"),
    expectedSha256: optionalString(args.expectedSha256),
  }
}

function asListDirArgs(args: Record<string, unknown>): ListDirArgs {
  return {
    path: requireString(args.path, "path"),
    recursive: optionalBoolean(args.recursive),
  }
}

function asSearchTextArgs(args: Record<string, unknown>): SearchTextArgs {
  return {
    query: requireString(args.query, "query"),
    path: optionalString(args.path),
    regex: optionalBoolean(args.regex),
  }
}

function asRunCommandArgs(args: Record<string, unknown>): RunCommandArgs {
  return {
    command: requireString(args.command, "command"),
    args: optionalStringArray(args.args),
    cwd: optionalString(args.cwd),
    timeoutMs: optionalNumber(args.timeoutMs),
  }
}

function asRunPythonArgs(args: Record<string, unknown>): RunPythonArgs {
  return {
    code: requireString(args.code, "code"),
    cwd: optionalString(args.cwd),
    timeoutMs: optionalNumber(args.timeoutMs),
    pythonCommand: optionalString(args.pythonCommand),
    pythonArgs: optionalStringArray(args.pythonArgs),
  }
}

async function listDirectory(scope: WorkspaceScope, root: string, recursive: boolean): Promise<Array<{ path: string; type: "file" | "dir"; size?: number }>> {
  const rows: Array<{ path: string; type: "file" | "dir"; size?: number }> = []
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(root, entry.name)
    const itemStat = await stat(fullPath)
    const type = entry.isDirectory() ? "dir" : "file"
    rows.push({
      path: toWorkspacePath(scope, fullPath),
      type,
      size: type === "file" ? itemStat.size : undefined,
    })

    if (recursive && entry.isDirectory() && !shouldSkipDir(entry.name)) {
      rows.push(...await listDirectory(scope, fullPath, true))
    }
  }

  return rows
}

async function collectFiles(scope: WorkspaceScope, root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      break
    }

    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        files.push(...await collectFiles(scope, fullPath, maxFiles - files.length))
      }
      continue
    }

    // 只搜索常见文本文件；二进制文件进入附件解析链路，不在 search_text 里硬读。
    if (isLikelyTextFile(fullPath)) {
      resolveWorkspacePath(scope, fullPath)
      files.push(fullPath)
    }
  }

  return files
}

function createMatcher(query: string, regex: boolean): (line: string) => boolean {
  if (!regex) {
    const normalizedQuery = query.toLowerCase()
    return (line) => line.toLowerCase().includes(normalizedQuery)
  }

  const pattern = new RegExp(query)
  return (line) => pattern.test(line)
}

function isLikelyTextFile(path: string): boolean {
  const name = basename(path)
  return !/\.(png|jpg|jpeg|gif|webp|ico|zip|gz|7z|rar|pdf|sqlite|db)$/i.test(name)
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === ".turbo"
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

function toWorkspacePath(scope: WorkspaceScope, fullPath: string): string {
  return relative(scope.rootDir, fullPath).replace(/\\/g, "/")
}

function formatToolData(data: unknown): string {
  if (typeof data === "string") {
    return data
  }
  return JSON.stringify(data, null, 2)
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmaError("bad_request", `工具参数 ${name} 必须是非空字符串。`, false)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined
}
