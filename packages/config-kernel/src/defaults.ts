/**
 * 系统默认配置值。
 *
 * @remarks
 * 这是最后一层 fallback，当用户配置、项目配置、会话覆盖均未命中时生效。
 * 所有默认值集中在此，方便审计与变更。
 */

import type { AppConfig } from "./schema.js";

/** 系统默认配置 */
export const DEFAULT_APP_CONFIG: Readonly<AppConfig> = {
  model: {
    chatModelId: "deepseek-chat",
    embeddingModelId: "local-bge-small",
    apiKeys: {},
    baseUrls: {},
  },
  features: {
    enableMemory: true,
    enableNarrative: true,
    enableLive2D: true,
    enableTts: false,
    enableStt: false,
    enableVision: false,
    enableMcp: false,
  },
};

/**
 * 生成一份默认配置的深拷贝，避免外部修改污染全局常量。
 */
export function makeDefaultConfig(): AppConfig {
  return structuredClone(DEFAULT_APP_CONFIG);
}
