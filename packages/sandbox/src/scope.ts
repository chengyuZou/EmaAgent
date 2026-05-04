import { resolve, sep } from "node:path"

import { EmaError } from "@ema-agent/core-types"

import type { WorkspaceScope } from "./types.js"

/**
 * 创建工作区 scope。
 *
 * rootDir 会被解析成绝对路径，后续所有路径检查都以它为边界。
 */
export function createWorkspaceScope(input: {
  rootDir: string
  allowWrite?: boolean
  allowNetwork?: boolean
  allowedCommands?: readonly string[]
}): WorkspaceScope {
  return {
    rootDir: resolve(input.rootDir),
    allowWrite: input.allowWrite ?? false,
    allowNetwork: input.allowNetwork ?? false,
    allowedCommands: input.allowedCommands ?? [],
  }
}

export function resolveWorkspacePath(scope: WorkspaceScope, relativeOrAbsolutePath: string): string {
  const resolvedPath = resolve(scope.rootDir, relativeOrAbsolutePath)
  assertInsideWorkspace(scope, resolvedPath)
  return resolvedPath
}

export function assertInsideWorkspace(scope: WorkspaceScope, targetPath: string): void {
  const root = ensureTrailingSeparator(resolve(scope.rootDir))
  const target = resolve(targetPath)

  if (target !== scope.rootDir && !ensureTrailingSeparator(target).startsWith(root)) {
    throw new EmaError("sandbox_denied", `路径不在工作区内：${target}`, false, {
      rootDir: scope.rootDir,
      targetPath: target,
    })
  }
}

export function assertWriteAllowed(scope: WorkspaceScope): void {
  if (!scope.allowWrite) {
    throw new EmaError("sandbox_denied", "当前工作区策略不允许写文件。", false)
  }
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`
}
