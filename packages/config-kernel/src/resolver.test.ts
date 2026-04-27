/**
 * Config Kernel - resolver 单元测试。
 *
 * @remarks
 * 覆盖 mergeConfigLayers 的边界 case：空数组、标量覆盖、嵌套合并、
 * undefined 跳过、多层优先级。
 */

import { describe, expect, it } from "vitest";
import { mergeConfigLayers } from "./resolver.js";
import { DEFAULT_APP_CONFIG } from "./defaults.js";
import type { AppConfig, FeatureConfig, ModelConfig } from "./schema.js";

function makeFullModel(partial: Partial<ModelConfig> = {}): ModelConfig {
  return {
    chatModelId: "default-chat",
    embeddingModelId: "default-emb",
    apiKeys: {},
    baseUrls: {},
    ...partial,
  };
}

function makeFullFeatures(partial: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    enableMemory: false,
    enableNarrative: false,
    enableLive2D: false,
    enableTts: false,
    enableStt: false,
    enableVision: false,
    enableMcp: false,
    ...partial,
  };
}

function makeAppConfig(partial: Partial<AppConfig> = {}): AppConfig {
  return {
    model: makeFullModel(partial.model),
    features: makeFullFeatures(partial.features),
  };
}

describe("mergeConfigLayers", () => {
  it("空数组应返回默认配置", () => {
    const result = mergeConfigLayers([]);
    expect(result.model.chatModelId).toBe(DEFAULT_APP_CONFIG.model.chatModelId);
    expect(result.features.enableMemory).toBe(DEFAULT_APP_CONFIG.features.enableMemory);
  });

  it("单层标量应直接覆盖", () => {
    // 传入部分 model，只覆盖 chatModelId
    const layer = { model: { chatModelId: "gpt-4" } as unknown as ModelConfig } as Partial<AppConfig>;
    const result = mergeConfigLayers([layer]);
    expect(result.model.chatModelId).toBe("gpt-4");
    // 未指定的嵌套字段应保留默认值
    expect(result.model.embeddingModelId).toBe(DEFAULT_APP_CONFIG.model.embeddingModelId);
  });

  it("嵌套对象应递归合并而非完全替换", () => {
    // 传入部分 features，只覆盖 enableTts
    const layer = { features: { enableTts: true } as unknown as FeatureConfig } as Partial<AppConfig>;
    const result = mergeConfigLayers([layer]);
    // 只改了一个字段，其他应保持默认
    expect(result.features.enableTts).toBe(true);
    expect(result.features.enableMemory).toBe(DEFAULT_APP_CONFIG.features.enableMemory);
    expect(result.features.enableNarrative).toBe(DEFAULT_APP_CONFIG.features.enableNarrative);
  });

  it("undefined 不应覆盖已有值", () => {
    const layer: Partial<AppConfig> = {
      model: makeFullModel({ chatModelId: undefined as unknown as string, embeddingModelId: "custom-emb" }),
    };
    const result = mergeConfigLayers([layer]);
    // chatModelId 为 undefined，不应覆盖默认值
    expect(result.model.chatModelId).toBe(DEFAULT_APP_CONFIG.model.chatModelId);
    expect(result.model.embeddingModelId).toBe("custom-emb");
  });

  it("多层应按右侧覆盖左侧优先级合并", () => {
    const project = {
      model: { chatModelId: "project-model", embeddingModelId: "project-emb" } as unknown as ModelConfig,
      features: { enableMemory: false } as unknown as FeatureConfig,
    } as Partial<AppConfig>;
    const user = {
      model: { chatModelId: "user-model" } as unknown as ModelConfig,
      features: { enableTts: true } as unknown as FeatureConfig,
    } as Partial<AppConfig>;

    const result = mergeConfigLayers([project, user]);

    // user 层覆盖 project 层的 chatModelId
    expect(result.model.chatModelId).toBe("user-model");
    // project 层的 embeddingModelId 未被 user 层覆盖
    expect(result.model.embeddingModelId).toBe("project-emb");
    // user 层 enableTts = true 覆盖默认值
    expect(result.features.enableTts).toBe(true);
    // project 层 enableMemory = false 覆盖默认值
    expect(result.features.enableMemory).toBe(false);
  });

  it("空对象不应覆盖已有嵌套值", () => {
    const layer: Partial<AppConfig> = { model: {} as ModelConfig };
    const result = mergeConfigLayers([layer]);
    // 空对象不是 undefined，递归合并时 { ...existing, ...{} } = existing
    expect(result.model.chatModelId).toBe(DEFAULT_APP_CONFIG.model.chatModelId);
  });

  it("多层嵌套应逐层递归合并", () => {
    const project = makeAppConfig({
      model: makeFullModel({ baseUrls: { openai: "https://proxy1.com" } }),
    });
    const user = makeAppConfig({
      model: makeFullModel({ baseUrls: { deepseek: "https://proxy2.com" } }),
    });

    const result = mergeConfigLayers([project, user]);

    // 两个不同的 key 都应保留
    expect(result.model.baseUrls).toEqual({
      openai: "https://proxy1.com",
      deepseek: "https://proxy2.com",
    });
  });
});
