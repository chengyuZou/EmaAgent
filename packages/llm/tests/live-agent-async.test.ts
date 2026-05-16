import { describe, it, expect } from 'vitest';
import { LlmRouter } from '../src/router.js';
import type { LlmRequest, ProviderConfig, LlmMessage } from '../src/types.js';

const ALIYUN_CONFIG: ProviderConfig = {
  id: 'aliyun',
  provider: 'openai-llm',
  apiKey: 'sk-44b410',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

const router = new LlmRouter([ALIYUN_CONFIG]);

describe.only('Advanced Live Tests: True Streaming Loops & Concurrency', () => {

  // ── 测试 1：纯流式拦截与即刻工具执行 ─────────────────────────────────────
  it('should execute tool immediately upon tool_use_complete in stream loop', async () => {
    let messages: LlmMessage[] = [
      { role: 'user', content: '查询一下深圳明天的天气如何？' }
    ];

    const tools = [{
      name: 'get_weather',
      description: '获取指定城市的当前天气情况',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location']
      }
    }];

    const request: LlmRequest = {
      providerId: 'aliyun', 
      model: 'qwen-plus', 
      messages, 
      tools,
      toolChoice: 'auto'
    };

    console.log('\n--- 开始流式第一轮 (监听工具调用) ---');
    let firstTurnAssistantContent = '';
    let toolCallId = '';
    let toolCallName = '';
    let toolCallArgs: any = null;

    for await (const chunk of router.stream(request)) {
      if (chunk.type === 'text_delta') {
        firstTurnAssistantContent += chunk.delta;
        process.stdout.write(chunk.delta); // 像 Claude 一样打字机
      } else if (chunk.type === 'tool_use_complete') {
        // [核心] 一旦收集齐参数，马上记录准备执行，不等待最后 done
        console.log(`\n⚡ [即刻拦截] 模型调用工具: ${chunk.name}(${JSON.stringify(chunk.args)})`);
        toolCallId = chunk.callId;
        toolCallName = chunk.name;
        toolCallArgs = chunk.args;
      }
    }

    expect(toolCallName).toBe('get_weather');

    messages.push({
      role: 'assistant',
      content: firstTurnAssistantContent,
      toolCalls: [{ id: toolCallId, name: toolCallName, args: toolCallArgs }]
    });

    const fakeWeatherResult = `模拟系统返回：${toolCallArgs.location}天气晴朗，气温28度`;
    messages.push({ role: 'tool', toolCallId, content: fakeWeatherResult });

    console.log('\n--- 开始流式第二轮 (带着工具结果总结) ---');
    let finalAnswer = '';
    
    for await (const chunk of router.stream({ ...request, messages })) {
      if (chunk.type === 'text_delta') {
        finalAnswer += chunk.delta;
        process.stdout.write(chunk.delta);
      }
    }
    console.log('\n');

    expect(finalAnswer).toMatch(/晴朗|28度|28/);
  }, 40000);

  // ── 测试 2：真正的非阻塞独立流式迸发（并发状态隔离） ─────────────────────────
  it('should stream completely independently without blocking each other', async () => {
    console.log('\n--- 开始压力测试：真实独立并发流式迸发 ---');

    const imageUrl = 'https://img2.baidu.com/it/u=3070515971,749491744&fm=253&fmt=auto&app=138&f=JPEG?w=891&h=500';

    // 定义 3 个互相独立的任务，直接封装成异步函数自己去跑自己的流
    const runTask = async (taskId: string, request: LlmRequest) => {
      let result = '';
      const startMs = Date.now();
      
      // 直接调用 stream，一旦有字马上就打印，彻底解耦
      for await (const chunk of router.stream(request)) {
        if (chunk.type === 'text_delta') {
          result += chunk.delta;
          // 我们用括号标明是哪个任务在吐字，你会看到终端里 [User1] 和 [User3] 在交替冒字！
          console.log(`[${taskId}]: ${chunk.delta}`); 
        }
      }
      
      const cost = Date.now() - startMs;
      console.log(`🏁 [${taskId}] 任务执行完毕 (耗时: ${cost}ms). 最终结果: ${result.slice(0, 30)}...`);
      return result;
    };

    // 同时启动三个截然不同的请求（不使用阻断的 await，让事件循环自由交织）
    const promises = [
      runTask('User1:苹果复读', {
        providerId: 'aliyun', model: 'qwen-plus', maxTokens: 50,
        messages: [{ role: 'user', content: '一直重复输出"苹果"这个词。' }]
      }),
      runTask('User2:图片识别', {
        providerId: 'aliyun', model: 'qwen-vl-plus', maxTokens: 50,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', url: imageUrl },
            { type: 'text', text: '图中是什么编程语言的 Logo？' }
          ]
        }]
      }),
      runTask('User3:算术计算', {
        providerId: 'aliyun', model: 'qwen-plus', maxTokens: 50,
        messages: [{ role: 'user', content: '1+1等于几？详细论述。' }]
      })
    ];

    // 测试必须等所有非阻塞任务自然终结后才能关闭，否则测试环境会强行杀死协程
    const results = await Promise.all(promises);

    expect(results[0]).toMatch(/苹果/);
    expect(results[1]?.toLowerCase()).toMatch(/python/i);
    expect(results[2]).toMatch(/2/);
  }, 40000);

});