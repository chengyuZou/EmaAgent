# LLM

`src/llm` 是 Ema 的语言模型执行面：接收已经解析好的协议连接与中立请求，把请求翻译给 Provider SDK，再返回统一流事件。

它不拥有 Provider 配置、模型目录、能力选择、Session/Turn、Context/Compact、重试策略或 Usage 持久化。

## 唯一调用链

```text
Provider / 接线层
  └─ 解析 provider config + model capability
       └─ createLlmCall({ providerId, protocol, apiKey, baseUrl }, modelId) // 连接与模型在创建点冻结
            └─ CallLlm(LlmRequest) → AsyncIterable<LlmStreamEvent>
                 └─ createLlmCompletion(stream) → LlmCompletion   // 同一条流的无损收集器，无第二条线路
```

支持的协议由 `@ema-agent/provider` 的 `LlmProtocol` 定义：

- `openai-llm`：OpenAI Chat Completions 及兼容网关；
- `openai-responses-llm`：OpenAI Responses API；
- `anthropic-llm`：Anthropic Messages；
- `gemini-llm`：Gemini 原生 generateContent。

Provider 是协议词汇和连接配置的唯一所有者。LLM 只消费 `LlmProtocol`，不得复制一份协议联合或按 Provider 品牌分发。

## 公共接口

```ts
const callLlm = createLlmCall({
  providerId,
  protocol: 'openai-llm',
  apiKey,
  baseUrl,
}, modelId);

for await (const event of callLlm({
  messages,
  tools,
  maxOutputTokens,
  signal,
})) {
  // Agent 处理 delta、Tool 调用、Usage 快照和 done。
}

// 要一把拿结果（标题生成、摘要等）：收集同一条流。
const completion = await createLlmCompletion(callLlm({ messages, signal }));
```

`LlmConnection` 只含调用目标身份以及建立 SDK Client 所需的协议、凭据和地址。`providerId + modelId + protocol` 用于判断历史原生推理状态能否安全重放；`LlmRequest` 只含一次调用变化的消息、Tool 定义、生成参数与取消信号。

以下字段明确不属于本包：

- `modelsDevId`：Provider Catalog 身份；
- `sessionId/turnId/llmCallId`：Turn/Agent 调用身份；
- `usageContext`：Usage 记录归属；
- retry/circuit/fallback：上层调用策略；
- 模型能力快照与附件降级：Provider + Context 决策；
- SQL、事件总线和前端 DTO。

## 流协议

每条正常流必须以一个显式 `done` 结束。SDK 自然断流、取消或 Provider 失败不会伪装成 `done`。

```text
(text_delta
 | thinking_delta
 | thinking_complete
 | tool_use_delta
 | tool_use_complete
 | usage)*
→ done
```

承载内容的事件带 `blockIndex`，上层用它恢复 text、thinking 与 tool_use 的交错顺序。`usage` 是 Provider 对当前调用给出的累计快照；`advanceLlmUsageSnapshot()` 负责把重复或倒退快照归一为单调快照和增量。

## 输入与协议边界

`Message` 是中立模型消息，不是 Session SQL 行，也不含 UI 字段。协议转换前会检查真实的表达限制：例如 Chat Completions 不接受文件块，Anthropic 不接受音频。无法表达时抛出 `LlmProtocolInputError`，禁止静默删除附件或把媒体替换成占位文本。

thinking 历史是唯一有意不跨调用目标重放的内容。不同 Provider、模型和协议的原生状态不兼容；只有 `providerId + modelId + protocol` 与当前目标完全一致时，Anthropic 才重放 signature、OpenAI Responses 才重放 reasoning item、Gemini 才重放 thoughtSignature。OpenAI Chat 没有统一的原生续接状态，只保留协议能够表达的普通 Assistant 内容。

Anthropic 的 `cache_control` 是协议专属投影：中立 Message 只携带 `cacheBreakpoint: true`，其他协议忽略该提示。

## 重试所有权

OpenAI 与 Anthropic SDK 的内建重试在创建 Client 时关闭。LLM 本包不重试：它不知道这次请求属于交互聊天、Macro Compact、Memory 提取还是后台任务，也无权决定是否重复计费或重新执行。

若上层确实需要重试，只能由一个调用边界拥有，并复用同一次业务调用身份；LLM 仍只执行一次协议请求。

## 文件职责

```text
src/llm/
├─ languageModel.ts      唯一创建入口、统一 thinking block 合成与 complete 流收集
├─ types.ts              请求、连接、Tool 投影和统一流事件
├─ message.ts            Provider 中立消息
├─ protocolInput.ts      真实协议输入限制，防止静默丢内容
├─ errors.ts             SDK 错误、取消与终态归一化
├─ usage.ts              调用级 Token 快照归一化
└─ protocols/
   ├─ openAiChat.ts
   ├─ openAiResponses.ts
   ├─ anthropic.ts
   └─ gemini.ts
```

协议文件只做三件事：创建并复用对应 SDK Client、转换请求、转换响应。它们不是公共 Adapter 注册表，也不拥有 Provider 热更新。
