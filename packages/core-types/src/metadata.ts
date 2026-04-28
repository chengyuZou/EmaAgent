/**
 * 运行时环境与静态元数据。
 *
 * 用于前端/后端共享的版本信息、环境标识、构建信息等。
 */

// ==========================================
// 版本信息
// ==========================================

export interface PackageVersion {
  /** 语义化版本号，如 "1.0.0"。 */
  semver: string
  /** Git commit hash（构建时注入）。 */
  gitHash?: string
  /** 构建时间 ISO 字符串。 */
  builtAt?: string
}

// ==========================================
// 运行时环境
// ==========================================

export interface RuntimeEnv {
  /** 运行平台：桌面、浏览器或 CI。 */
  platform: "darwin" | "linux" | "windows" | "browser" | "unknown"
  /** 是否在 Electron 壳中。 */
  isElectron: boolean
  /** Node.js 版本（仅非浏览器环境）。 */
  nodeVersion?: string
  /** 用户区域设置，如 "zh-CN"。 */
  locale: string
  /** 时区，如 "Asia/Shanghai"。 */
  timezone: string
}