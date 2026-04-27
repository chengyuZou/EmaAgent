/**
 * 测试 router 的注册、查询和路由分发功能
 */

import type { ChatCompletionChunk, ChatCompletionRequest, ModelDescriptor } from "@ema-agent/core-types";
import { describe, it, expect, beforeEach } from "vitest";
import { 
  registerLlmProvider, 
  listProviders, 
  listModelsByProvider,
  resolveProviderByModelId,
  streamComplete,
  completeText
} from "./router.js";


describe("LLM Provider Router (P0 Architecture Baseline)", () => {
  // Mock Data
  const mockDeepseekModel: ModelDescriptor = {
    id: "deepseek-chat",
    providerId: "deepseek",
    displayName: "DeepSeek Chat",
    contextWindow: 32000,
    maxOutputTokens: 4000,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
  };

  const mockDeepseekProvider = {
    id: "deepseek",
    displayName: "DeepSeek Provider",
    website: "https://deepseek.com",
    icon: "deepseek-icon",
    // 强制遵从新基线: 使用 models 而不是 supportedModels
    models: [mockDeepseekModel],
    chat: (req: ChatCompletionRequest) => Promise.resolve(`Mocked response for ${req.modelId}`),
    chatStream: async function* (req: ChatCompletionRequest): AsyncIterable<ChatCompletionChunk> {
      yield { index: 0, delta: { content: `Stream mocked chunk for ${req.modelId}` } };
    }
  };

  beforeEach(() => {
    // 确保我们使用的是干净的环境（虽然这里只是注入同名内容）
    registerLlmProvider(mockDeepseekProvider);
  });

  it("1. registers and lists providers properly", () => {
    const providers = listProviders();
    expect(providers).toContainEqual({
      id: "deepseek",
      displayName: "DeepSeek Provider",
      website: "https://deepseek.com",
      icon: "deepseek-icon",
      enabled: true,
      configured: true,
      kind: "llm"
    });
  });

  it("2. listModelsByProvider('deepseek') returns deepseek models", () => {
    const models = listModelsByProvider("deepseek");
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("deepseek-chat");
    expect(models[0].providerId).toBe("deepseek");
  });

  it("3. resolveProviderByModelId('deepseek-chat') returns deepseek provider", () => {
    const provider = resolveProviderByModelId("deepseek-chat");
    expect(provider.id).toBe("deepseek");
  });

  it("4. throws error for unknown model or provider", () => {
    expect(() => listModelsByProvider("unknown-provider")).toThrowError(/Provider with id 'unknown-provider' not found/);
    expect(() => resolveProviderByModelId("unknown-model")).toThrowError(/No provider found for model id 'unknown-model'/);
  });

  it("5. streamComplete() calls the correct provider's chatStream", async () => {
    const reqBase: Omit<ChatCompletionRequest, "modelId"> = {
      sessionId: "session-1",
      messages: [{ role: "user", content: "Hello" }]
    };
    const stream = streamComplete("deepseek-chat", reqBase);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].delta.content).toBe("Stream mocked chunk for deepseek-chat");
  })

  it("6. completeText() calls the correct provider's chat", async () => {
    const reqBase: Omit<ChatCompletionRequest, "modelId"> = {
      sessionId: "session-2",
      messages: [{ role: "user", content: "Hi" }]
    };

    // 直接使用 modelId 作为路由
    const response = await completeText("deepseek-chat", reqBase);
    expect(response).toBe("Mocked response for deepseek-chat");
  });

});
