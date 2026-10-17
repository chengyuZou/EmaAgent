# LLM

`src/llm` 是 Ema 的语言模型执行面:接收已经解析好的协议连接与中立请求,把请求翻译给 Provider SDK,再返回统一流事件.

它不拥有 Provider 配置,模型目录,能力选择,Session/Turn,Context/Compact,重试策略或 Usage 持久化.

## 唯一调用链

```text
Provider / 接线层
  └─ 解析 provider config + model capability
       └─ createLlmCall({ providerId, protocol, apiKey, baseUrl }, modelId) // 连接与模型在创建点冻结
            └─ CallLlm(LlmRequest) → AsyncIterable<LlmStreamEvent>
                 └─ createLlmCompletion(stream) → LlmCompletion   // 同一条流的无损收集器,无第二条线路
```

支持的协议由 `@ema-agent/providers` 的 `LLMProtocol` 定义:

- `openai-llm`:OpenAI Chat Completions 及兼容网关;
- `openai-responses-llm`:OpenAI Responses API;
- `anthropic-llm`:Anthropic Messages;
- `gemini-llm`:Gemini 原生 generateContent.

Provider 是协议词汇和连接配置的唯一所有者.LLM 只消费 `LLMProtocol`,不得复制一份协议联合或按 Provider 品牌分发.

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
  // Agent 处理 delta,Tool 调用,Usage 快照和 done.
}

// 要一把拿结果(标题生成,摘要等):收集同一条流.
const completion = await createLlmCompletion(callLlm({ messages, signal }));
```

`LlmConnection` 只含调用目标身份以及建立 SDK Client 所需的协议,凭据和地址.`providerId + modelId + protocol` 用于判断历史原生推理状态能否安全重放;`LlmRequest` 只含一次调用变化的消息,Tool 定义,生成参数与取消信号.

导入本包或调用 `createLlmCall` 不加载厂商 SDK. `createLlmCall` 同步返回调用函数, 并保存创建时的连接值. 第一次消费返回的流时, 才加载所选协议并创建 SDK Client. 同一个 `CallLlm` 的并发和后续请求共用一次初始化; 不同调用对象不共用客户端. 协议模块由 Node 缓存, 未使用的协议不提前加载.

空模型名仍在创建时拒绝, 不支持的消息仍在调用 `CallLlm(request)` 时同步拒绝. 模块加载和客户端创建错误从流中抛出. 请求开始消费前已经取消时不初始化; 加载期间取消则在加载完成后停止该请求, 不发送网络请求, 也不取消其他请求共用的初始化. 首次请求承担对应 SDK 的加载时间, 不影响流事件与 Usage 的含义.

以下字段明确不属于本包:

- `modelsDevId`:Provider Catalog 身份;
- `sessionId/turnId/llmCallId`:Turn/Agent 调用身份;
- `usageContext`:Usage 记录归属;
- retry/circuit/fallback:上层调用策略;
- 模型能力与图片是否转成描述: Provider + Context 决策;
- SQL,事件总线和前端 DTO.

## 流协议

每条正常流必须以一个显式 `done` 结束.SDK 自然断流,取消或 Provider 失败不会伪装成 `done`.

```text
(text_delta
 | thinking_delta
 | thinking_complete
 | tool_use_delta
 | tool_use_complete
 | usage)*
→ done
```

承载内容的事件带 `blockIndex`,上层用它恢复 text,thinking 与 tool_use 的交错顺序.`usage` 是 Provider 对当前调用给出的累计快照;`updateLlmCallUsage()` 负责把重复或倒退快照归一为当前已知用量和新增量.

## 输入与协议边界

`Message` 是中立模型消息, 不是 Session SQL 行, 也不含 UI 字段. 协议转换前会检查真实的表达限制: 例如 Chat Completions 不接受文件块, Anthropic 不接受音频. 无法表达且没有明确转换规则时抛出 `LlmProtocolInputError`, 不静默删除内容. Chat 工具图片有明确的文字占位规则, 可以进入转换.

工具图片仍是 `tool_result.content` 中的 `image_data` / `image_url`, 保留原始调用 ID. Chat 转换时按原顺序将工具图片换成明确的文字占位, 告知本次没有读取图片内容, 并提示可用时调用 DescribeImage 或选择合适的协议与视觉模型. 原有文字与工具配对保留, 不增加用户图片消息或修改保存的结果.

LLM 不选择模型能力,不调用 Vision,不读文件, 也不保存工具图片描述缓存. 当前 SDK 转换方式如下:

| 协议 | 工具图片传递方式 |
| --- | --- |
| OpenAI Chat Completions | `tool` 回复只放文字; 每个图片块原地换成明确占位, 不追加用户图片消息. |
| OpenAI Responses | `function_call_output.output` 使用原生文字/图片数组, `call_id` 不变. 字符串结果仍传字符串. |
| Anthropic Messages | 图片放在原生 `tool_result.content` 内. |
| Gemini generateContent | `functionResponse.response` 只放文字/JSON; 整批回复之后追加标明来源的 `inlineData` / `fileData` 图片内容, 不把 Base64 放进普通 JSON. |

协议转换只影响 SDK 请求, 不增加 Session 消息,附件或持久化记录. 普通用户图片的转换保持现有行为, 附件描述由 Context 处理. DescribeImage 是单独的内置工具, 由主模型显式调用, 与 LLM 协议转换无关.

OpenAI SDK 使用支持 Node 20 的 6.x 版本, 其 Responses 类型已经包含图片工具输出. `tests/openAiChat.test.ts`, `tests/openAiResponsesProtocol.test.ts` 和 `tests/nativeProtocols.test.ts` 使用 SDK 测试替身检查工具图片请求与流事件. `tests/languageModelImport.test.ts` 检查按需加载, 并发初始化和取消, `tests/languageModel.test.ts` 检查连接固定, 客户端复用和完整结果收集; 不访问真实模型服务.

thinking 历史是唯一有意不跨调用目标重放的内容.不同 Provider,模型和协议的原生状态不兼容;只有 `providerId + modelId + protocol` 与当前目标完全一致时,Anthropic 才重放 signature,OpenAI Responses 才重放 reasoning item,Gemini 才重放 thoughtSignature.OpenAI Chat 没有统一的原生续接状态,只保留协议能够表达的普通 Assistant 内容.

Anthropic 的 `cache_control` 是协议专属投影:中立 Message 只携带 `cacheBreakpoint: true`,其他协议忽略该提示.

## 重试所有权

OpenAI 与 Anthropic SDK 的内建重试在创建 Client 时关闭.LLM 本包不重试:它不知道这次请求属于交互聊天,Macro Compact,Memory 提取还是后台任务,也无权决定是否重复计费或重新执行.

若上层确实需要重试,只能由一个调用边界拥有,并复用同一次业务调用身份;LLM 仍只执行一次协议请求.

## 文件职责

```text
src/llm/
├─ languageModel.ts      唯一创建入口,统一 thinking block 合成与 complete 流收集
├─ types.ts              请求,连接,Tool 投影和统一流事件
├─ message.ts            Provider 中立消息
├─ protocolInput.ts      真实协议输入限制,防止静默丢内容
├─ errors.ts             SDK 错误,取消与终态归一化
├─ usage.ts              调用级 Token 快照归一化
└─ protocols/
   ├─ openAiChat.ts
   ├─ openAiResponses.ts
   ├─ anthropic.ts
   └─ gemini.ts
```

协议文件只做三件事:创建并复用对应 SDK Client,转换请求,转换响应.它们不是公共 Adapter 注册表,也不拥有 Provider 热更新.
