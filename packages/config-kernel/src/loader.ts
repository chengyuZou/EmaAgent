/**
 * 配置分层加载器。
 *
 * @remarks
 * 加载优先级（从高到低）：
 * Session Overrides -> User Config -> Project Config -> Default
 * 各层通过 {@link mergeConfigLayers} 合并。
 */

import type { AppConfig } from "./schema.js";

/**
 * 读取项目级配置（仓库目录下的 `.ema/config.json`）。
 *
 * @remarks
 * 项目配置用于团队共享的默认模型、baseUrl 等。
 */
export async function loadProjectConfig(): Promise<Partial<AppConfig>> {
  // TODO: 实现文件读取与 JSON 解析
  return {};
}

/**
 * 读取用户级配置（系统用户目录下的 `~/.ema/user-config.json`）。
 *
 * @remarks
 * 用户配置包含 API 密钥、个人偏好等敏感信息，不应进入版本控制。
 */
export async function loadUserConfig(): Promise<Partial<AppConfig>> {
  // TODO: 实现文件读取与 JSON 解析
  return {};
}

/**
 * 读取会话级覆盖配置。
 *
 * @param sessionId - 目标会话 ID
 */
export async function loadSessionOverrides(sessionId: string): Promise<Partial<AppConfig>> {
  // TODO: 从 storage-sql 读取会话覆盖
  void sessionId;
  return {};
}
