/**
 * V1 静态模型目录。
 *
 * 05-07 会继续做 provider registry / catalog / health / config。这里先把 05-03/05-04
 * 几个首发 adapter 需要展示和路由的模型元数据集中放置，避免散落硬编码。
 */

import type { ModelCapabilities, ModelDescriptor } from "@ema-agent/core-types";

const OPENAI_TEXT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  structuredOutput: true,
  promptCache: true,
  listModels: true,
};

const ANTHROPIC_TEXT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  structuredOutput: true,
  promptCache: true,
  listModels: true,
};

const GEMINI_TEXT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  structuredOutput: true,
  promptCache: true,
  listModels: true,
};

const OPENAI_COMPATIBLE_TEXT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: false,
  structuredOutput: true,
  promptCache: false,
  listModels: true,
};

export const OPENAI_NATIVE_MODELS: readonly ModelDescriptor[] = [
  {
    id: "gpt-5.2",
    providerId: "openai",
    displayName: "GPT-5.2",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: OPENAI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 1.75, outputPer1M: 14 },
    source: "static",
  },
  {
    id: "gpt-5.2-codex",
    providerId: "openai",
    displayName: "GPT-5.2 Codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: OPENAI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 1.75, outputPer1M: 14 },
    source: "static",
  },
  {
    id: "gpt-5-mini",
    providerId: "openai",
    displayName: "GPT-5 mini",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: OPENAI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 0.25, outputPer1M: 2 },
    source: "static",
  },
  {
    id: "gpt-4.1",
    providerId: "openai",
    displayName: "GPT-4.1",
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    capabilities: OPENAI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 2, outputPer1M: 8 },
    source: "static",
  },
];

export const ANTHROPIC_NATIVE_MODELS: readonly ModelDescriptor[] = [
  {
    id: "claude-opus-4-1-20250805",
    providerId: "anthropic",
    displayName: "Claude Opus 4.1",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ANTHROPIC_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 15, outputPer1M: 75 },
    source: "static",
  },
  {
    id: "claude-sonnet-4-20250514",
    providerId: "anthropic",
    displayName: "Claude Sonnet 4",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: ANTHROPIC_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
    source: "static",
  },
  {
    id: "claude-3-5-haiku-20241022",
    providerId: "anthropic",
    displayName: "Claude Haiku 3.5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ANTHROPIC_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    pricing: { inputPer1M: 0.8, outputPer1M: 4 },
    source: "static",
  },
];

export const GEMINI_NATIVE_MODELS: readonly ModelDescriptor[] = [
  {
    id: "gemini-2.5-pro",
    providerId: "gemini",
    displayName: "Gemini 2.5 Pro",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: GEMINI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    source: "static",
  },
  {
    id: "gemini-2.5-flash",
    providerId: "gemini",
    displayName: "Gemini 2.5 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: GEMINI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    source: "static",
  },
  {
    id: "gemini-2.5-flash-lite",
    providerId: "gemini",
    displayName: "Gemini 2.5 Flash Lite",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    capabilities: GEMINI_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    source: "static",
  },
];

export const DEEPSEEK_COMPATIBLE_MODELS: readonly ModelDescriptor[] = [
  {
    id: "deepseek-chat",
    providerId: "deepseek",
    displayName: "DeepSeek Chat",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    capabilities: OPENAI_COMPATIBLE_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    source: "static",
  },
  {
    id: "deepseek-reasoner",
    providerId: "deepseek",
    displayName: "DeepSeek Reasoner",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    capabilities: OPENAI_COMPATIBLE_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    source: "static",
  },
];

export const OPENROUTER_COMPATIBLE_MODELS: readonly ModelDescriptor[] = [
  {
    id: "openrouter/auto",
    providerId: "openrouter",
    displayName: "OpenRouter Auto",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: OPENAI_COMPATIBLE_TEXT_CAPABILITIES,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    source: "static",
  },
];

export const OLLAMA_COMPATIBLE_MODELS: readonly ModelDescriptor[] = [
  {
    id: "llama3.1",
    providerId: "ollama",
    displayName: "Llama 3.1",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: {
      ...OPENAI_COMPATIBLE_TEXT_CAPABILITIES,
      listModels: true,
    },
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    source: "static",
  },
  {
    id: "qwen2.5-coder",
    providerId: "ollama",
    displayName: "Qwen 2.5 Coder",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: {
      ...OPENAI_COMPATIBLE_TEXT_CAPABILITIES,
      listModels: true,
    },
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    source: "static",
  },
];
