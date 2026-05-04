/**
 * 应用环境与静态元数据——前后端共享的版本信息、环境标识、构建信息。
 *
 * 这些类型不参与业务流转，仅供健康检查、devtools 面板和日志上下文使用。
 */

// ═══════════════════════════════════════════════════════════════
// 版本信息
// ═══════════════════════════════════════════════════════════════

/**
 * 包版本信息——构建时由 CI 注入。
 *
 * @example
 * // BFF /api/health 返回的版本信息
 * const version: PackageVersion = {
 *   semver: "1.0.0",
 *   gitHash: "dc73ed6",
 *   builtAt: "2026-05-04T08:30:00.000Z",
 * }
 */
export interface PackageVersion {
  /** 语义化版本号，如 "1.0.0"。 */
  semver: string
  /** Git commit hash（构建时注入）。 */
  gitHash?: string
  /** 构建时间 ISO 字符串。 */
  builtAt?: string
}

// ═══════════════════════════════════════════════════════════════
// 应用环境
// ═══════════════════════════════════════════════════════════════

/**
 * 应用运行时环境快照——前端在初始化时发送给 BFF，BFF 据此调整输出格式。
 *
 * @example
 * // 前端在 StartTurnRequest.client 中携带的环境信息
 * const env: AppEnvironment = {
 *   platform: "windows",
 *   isElectron: true,
 *   nodeVersion: "22.0.0",
 *   locale: "zh-CN",
 *   timezone: "Asia/Shanghai",
 * }
 */
export interface AppEnvironment {
  /** 运行平台：桌面、浏览器或 CI。 */
  platform: "darwin" | "linux" | "windows" | "browser" | "unknown"
  /** 是否在 Electron / Tauri 壳中。 */
  isElectron: boolean
  /** Node.js 版本（仅非浏览器环境）。 */
  nodeVersion?: string
  /** 用户区域设置，如 "zh-CN"。 */
  locale: string
  /** 时区 IANA 标识，如 "Asia/Shanghai"。 */
  timezone: string
}
