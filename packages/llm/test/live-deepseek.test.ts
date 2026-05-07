import { describe, it, expect } from "vitest"
import { asId } from "@ema-agent/core-types"
import type { ModelId, ProviderId } from "@ema-agent/core-types"
import { LlmClient } from "../src/client.js"

// 注意：这是一个真实调用 API 的端到端测试。
// 运行这个测试时，请将 `sk-xxx` 替换为你的真实 DeepSeek API Key。
// 我们移除了 `.skip` 改用 `describe.only`，这样当你运行 vitest 时，只会执行这个块，方便调试调试。
describe.only("Live API - DeepSeek", () => {
  it("should stream response from deepseek using openai-compatible provider", async () => {
    const client = new LlmClient()

    // 1. 注册 DeepSeek 作为一个 OpenAI 兼容的 Provider
    client.upsertProvider({
      id: asId<ProviderId>("deepseek"),
      kind: "openai-compatible",
      displayName: "DeepSeek",
      enabled: true,
      baseUrl: "https://api.deepseek.com/v1", // 或者 "https://api.deepseek.com/v1"，请根据 DeepSeek 文档确认
      apiKey: "sk-1d68690a08aa42eeb38ea38d88b1855c", // <-- 🔑 修改这里
    })

    console.log("\n🚀 开始请求 DeepSeek...")

    // 2. 发起真实流式请求
    const stream = client.streamChat({
      providerId: asId<ProviderId>("deepseek"),
      modelId: asId<ModelId>("deepseek-chat"), // 可选：deepseek-chat 或者 deepseek-coder/deepseek-reasoner
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "北京现在的天气怎么样？请调用工具查询。" },
      ],
      tools: [
        {
          name: "get_weather",
          description: "获取指定城市的天气状态",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string", description: "城市名称，例如：北京、上海" },
            },
            required: ["location"],
          },
        }
      ],
      temperature: 0.7,
      maxTokens: 512,
    })

    let fullResponse = ""
    let toolCallName = ""
    let toolCallArgs = ""
    
    // 3. 消费 Chunk 并控制台打印
    for await (const chunk of stream) {
      if (chunk.delta.content) {
        process.stdout.write(chunk.delta.content)
        fullResponse += chunk.delta.content
      }

      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        for (const tc of chunk.toolCalls) {
          if (tc.toolName) {
            toolCallName = tc.toolName
            process.stdout.write(`\n\n[决定调用工具: ${tc.toolName}]\n参数流: `)
          }
          if (tc.argumentsDelta) {
            process.stdout.write(tc.argumentsDelta)
            toolCallArgs += tc.argumentsDelta
          }
        }
      }
    }
    
    console.log("\n\n✅ 响应结束！")
    if (fullResponse) {
      console.log("完整文本响应：", fullResponse)
    }
    if (toolCallName) {
      console.log("\n🔧 工具调用详情：")
      console.log("  - 工具名称:", toolCallName)
      console.log("  - 工具参数:", toolCallArgs)
    }

    // 简单断言有输出返回，或者至少响应了工具调用
    expect(fullResponse.length + toolCallArgs.length).toBeGreaterThan(0)
  }, 30000) // 放宽真实网络请求的超时时间至 30s
})
