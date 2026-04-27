/**
 * Provider 与 Model 的路由与注册中心。
 * 架构目标：维护两张映射表，隔离 Provider 与 Model，确保调用请求直接通过 Model ID 找到正确实现。
 */

import type { ChatCompletionChunk, ChatCompletionRequest, ModelDescriptor, ProviderDescriptor } from "@ema-agent/core-types";
import type { LlmProvider } from "./provider.js";

/** * 按 Provider ID 索引的注册表
 * 用于：前端设置页展示服务源、管理连接配置 
 */
const providersById = new Map<string, LlmProvider>();

/** * 按 Model ID 索引的注册表
 * 用于：实际大模型调用的精准路由分发
 */
const providersByModelId = new Map<string, LlmProvider>();

/** * 注册 LLM Provider
 * @note 会自动将该 provider 下的 models 注册到路由表中
 */
export function registerLlmProvider(provider: LlmProvider): void {
  providersById.set(provider.id, provider);
  for (const model of provider.models) {
    providersByModelId.set(model.id, provider);
  }
}

/** 返回所有已注册的 Provider (供给设置页等管理界面) */
export function listProviders(): ProviderDescriptor[] {
  return Array.from(providersById.values()).map(p => ({
    id: p.id,
    displayName: p.displayName,
    website: p.website,
    icon: p.icon,
    enabled: true,
    configured: true,
    kind: "llm"
  }));
}

/** 返回指定 Provider 旗下包含的可用模型列表 */
export function listModelsByProvider(providerId: string): readonly ModelDescriptor[] {
  const provider = providersById.get(providerId);
  if (!provider) {
    throw new Error(`Provider with id '${providerId}' not found`);
  }
  return provider.models;
}

/**
 * 内部路由函数：通过 Model ID 找到其归属的 Provider 实例
 */
export function resolveProviderByModelId(modelId: string): LlmProvider {
  const provider = providersByModelId.get(modelId);
  if (!provider) {
    throw new Error(`No provider found for model id '${modelId}'`);
  }
  return provider;
}

/**
 * [核心分发] 发起流式对话。
 * 使用方只需提供模型 ID 和剩余请求参数，即可路由给对应的 Provider 执行。
 */
export function streamComplete(modelId: string, req: Omit<ChatCompletionRequest, "modelId">): AsyncIterable<ChatCompletionChunk> {
  const provider = resolveProviderByModelId(modelId);
  // 重组 request 对象传递给底层实现
  return provider.chatStream({ ...req, modelId });
}

/**
 * [核心分发] 发起单次完整的对话。
 * 使用方只需提供模型 ID 和剩余请求参数，即可路由给对应的 Provider 执行。
 */
export function completeText(modelId: string, req: Omit<ChatCompletionRequest, "modelId">): Promise<string> {
  const provider = resolveProviderByModelId(modelId);
  // 重组 request 对象传递给底层实现
  return provider.chat({ ...req, modelId });
}
