import { describe, it, expect } from 'vitest';
import { LanguageModelRuntime } from '../languageModelRuntime.js';
import type { LlmRequest, ProviderConfig } from '../types.js';

// 阿里云百炼 OpenAI 兼容配置
const ALIYUN_CONFIG: ProviderConfig = {
  protocol: 'openai-llm',
  apiKey: 'sk-4',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

// 实例化您重构后的 Router 架构
const router = new LanguageModelRuntime([ALIYUN_CONFIG]);

// 使用 describe.only 确保单测时只跑这些真实请求的网络测试
describe.only('Live Aliyun Provider Tests (Qwen Models)', () => {
  // 1. 测试基础多轮对话与普通流式输出
  it('should stream text chunks for basic conversation', async () => {
    const request: LlmRequest = {
      protocol: 'openai-llm',
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: '你是一个乐于助人的AI助手，请用中文回答。' },
        { role: 'user', content: '请给我讲一个两句话的冷笑话。' },
      ],
    };

    let textBuffer = '';
    let hasEndTurn = false;

    for await (const chunk of router.stream(request)) {
      if (chunk.type === 'text_delta') {
        textBuffer += chunk.delta;
      } else if (chunk.type === 'done') {
        hasEndTurn = true;
        expect(chunk.stopReason).toBe('end_turn');
      }
    }

    expect(textBuffer.length).toBeGreaterThan(0);
    expect(hasEndTurn).toBe(true);
    console.log('--- 基础文本流输出 ---');
    console.log(textBuffer);
  }, 30000); // 增加超时时间以应对真实网络请求

  // 2. 测试 complete 包装器与 Function Calling（工具调用）
  it('should successfully trigger a tool call', async () => {
    const request: LlmRequest = {
      protocol: 'openai-llm',
      model: 'qwen-plus',
      messages: [
        { role: 'user', content: '查询一下北京今天的天气如何。' },
      ],
      tools: [
        {
          name: 'get_weather',
          description: '获取指定城市的当前天气情况',
          parameters: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: '城市名，例如：北京, 上海',
              },
            },
            required: ['location'],
          },
        },
      ],
      toolChoice: 'auto',
    };

    // 使用我们刚在 LanguageModelRuntime 中发现的完整收集包装器
    const completion = await router.complete(request);

    // 引擎应返回 tool_use 作为停止原因
    expect(completion.stopReason).toBe('tool_use');
    expect(completion.toolCalls).toBeDefined();
    expect(completion.toolCalls!.length).toBeGreaterThan(0);

    const call = completion.toolCalls![0];
    expect(call.name).toBe('get_weather');

    // 验证 args 是否被正确解析为 JSON 对象
    const args = call.args as { location: string };
    expect(args.location).toBe('北京');

    console.log('--- 工具调用结果 ---');
    console.log(call);
  }, 30000);

  // 3. 测试 Vision 视觉模型（使用多模态消息体）
  it('should process image_url using vision model', async () => {
    // 设置一张作为测试用的公共图片猫咪 URL
    const imageUrl = 'https://fc1tn.baidu.com/it/u=1839792386,3938688859&fm=202&src=1024&fc_m=pc_3_2&mola=new&crop=v1';
    
    const request: LlmRequest = {
      protocol: 'openai-llm',
      // 请注意：阿里云具有视觉能力的模型以 -vl- 结尾
      model: 'qwen-vl-plus', 
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片里有什么动物？请简要描述。' },
            { type: 'image_url', url: imageUrl},
          ],
        },
      ],
    };

    const completion = await router.complete(request);

    expect(completion.text).toBeDefined();
    expect(completion.text?.length).toBeGreaterThan(0);
    // 判断大模型回复中是否包含了猫的字眼
    expect(completion.text).toMatch(/猫|cat/i);

    console.log('--- 视觉模型解析输出 ---');
    console.log(completion.text);
  }, 30000);
});