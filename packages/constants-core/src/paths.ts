/**
 * 路径与文件系统常量 — 工作区、临时目录、跳过目录、文件扩展名。
 */

// ═══════════════════════════════════════════════════════════════
// 工作区路径
// ═══════════════════════════════════════════════════════════════

/** Agent 工作区内的临时文件目录（相对于 session workspace）。 */
export const WORKSPACE_TMP_DIR = ".ema-agent/tmp"

/** 默认 Python 命令。 */
export const DEFAULT_PYTHON_COMMAND = "python"

// ═══════════════════════════════════════════════════════════════
// 跳过目录（搜索/扫描时忽略）
// ═══════════════════════════════════════════════════════════════

/** 文件搜索/扫描时默认跳过的目录名。 */
export const SKIP_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".cache",
] as const

// ═══════════════════════════════════════════════════════════════
// 二进制文件扩展名（读取时跳过或 base64 处理）
// ═══════════════════════════════════════════════════════════════

/** 常见二进制文件扩展名——文件操作时不作文本读取。 */
export const BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".zip", ".gz", ".7z", ".rar",
  ".pdf",
  ".sqlite", ".db",
  ".mp3", ".wav", ".ogg", ".opus", ".aac",
  ".mp4", ".webm", ".mov", ".avi",
  ".exe", ".dll", ".so", ".dylib",
  ".bin", ".dat",
])

/** 判断文件扩展名是否为二进制。 */
export function isBinaryFile(ext: string): boolean {
  return BINARY_FILE_EXTENSIONS.has(ext.toLowerCase())
}
