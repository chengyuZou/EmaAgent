/**
 * 配置 schema 定义：AIRI 式分层配置系统的数据结构。
 */

/** 顶层应用配置 */
export interface AppConfig {
  /** 当前激活的模型配置 */
  model: ModelConfig;
  /** 功能开关 */
  features: FeatureConfig;
}

/** 模型配置 */
export interface ModelConfig {
  /** 默认对话模型 */
  chatModelId: string;
  /** 默认 Embedding 模型 */
  embeddingModelId: string;
  /** 各模型提供方 API 密钥 */
  apiKeys: Record<string, string>;
  /** 各模型提供方 baseURL（可选，用于本地代理） */
  baseUrls?: Record<string, string>;
}

/** 功能开关配置 */
export interface FeatureConfig {
  /** 是否启用长期记忆召回 */
  enableMemory: boolean;
  /** 是否启用 narrative 剧情模式 */
  enableNarrative: boolean;
  /** 是否启用 Live2D */
  enableLive2D: boolean;
  /** 是否启用 TTS */
  enableTts: boolean;
  /** 是否启用 STT */
  enableStt: boolean;
  /** 是否启用 Vision 视觉分析 */
  enableVision: boolean;
  /** 是否启用 MCP */
  enableMcp: boolean;
}
