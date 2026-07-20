import { describe, it, expect } from 'vitest';
import { LanguageModelRuntime } from '../languageModelRuntime.js';
import type { LlmRequest, ProviderConfig } from '../types.js';

// 1. OpenAI 兼容配置
const OPENAI_COMPAT_CONFIG: ProviderConfig = {
  id: 'aliyun-llm',
  protocol: 'openai-llm',
  apiKey: 'sk-44b',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

// 2. Anthropic 兼容配置
const ANTHROPIC_COMPAT_CONFIG: ProviderConfig = {
  id: 'aliyun-anthropic',
  protocol: 'anthropic-llm',
  apiKey: 'sk-44bxxx70443b8', 
  // ‼️ 注意这里：不要带 /v1/messages 后缀，因为 Anthropic SDK 会在底层自动追加
  baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
};

const router = new LanguageModelRuntime([OPENAI_COMPAT_CONFIG, ANTHROPIC_COMPAT_CONFIG]);

describe.only('Live Tool Streaming & Multi-Provider Tests', () => {

  it('should stream tool arguments chunk by chunk (打字机式输出工具参数)', async () => {
    const request: LlmRequest = {
      // 在这里随时可以切成 'aliyun-anthropic' 来验证 Anthropic 下的工具调用
      providerId: 'aliyun-llm', 
      model: 'qwen-plus',
      messages: [{ role: 'user', content: '查询北京和上海的天气' }],
      tools: [{
        name: 'get_weather',
        description: '获取城市天气',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      }],
      toolChoice: 'auto',
    };

    let fullArgs = '';
    console.log('--- 观察工具参数的流式生成过程 (Stream Chunks) ---');

    for await (const chunk of router.stream(request)) {
      if (chunk.type === 'tool_use_delta') {
        fullArgs += chunk.argsDelta;
        console.log(`[工具参数流片段]: ${chunk.argsDelta}`);
      } else if (chunk.type === 'tool_use_complete') {
        console.log(`\n[工具调用完成] 最终组合的完整参数:`, JSON.stringify(chunk.args));
        expect(chunk.name).toBe('get_weather');
      } else if (chunk.type === 'done') {
        expect(chunk.stopReason).toBe('tool_use');
      }
    }

    expect(fullArgs.length).toBeGreaterThan(0);
  }, 30000);

  it('should request via Anthropic format if adapter is supported', async () => {
    const request: LlmRequest = {
      providerId: 'aliyun-anthropic',
      // 指定使用百炼中支持 Anthropic 协议的模型
      model: 'qwen3.6-plus', 
      messages: [
        { role: 'system', content: '你是一个严格的数学助手。' },
        { role: 'user', content: '9.11 和 9.8 谁大？' },
      ],
    };

    // 使用 complete 验证这个全新的 Anthropic 兼容端点是否畅通
    const completion = await router.complete(request);
    console.log('--- Anthropic 兼容接口返回内容 ---');
    console.log(completion.text);
    expect(completion.text).toBeDefined();
    expect(completion.text?.length).toBeGreaterThan(0);
  }, 30000);

});